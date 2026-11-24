// HTTP routes for accounts and sync, mounted at /api/account.
//   GET  /api/account         -> { user, signup }            (user is null when signed out)
//   POST /api/account/signup  { username, password }
//   POST /api/account/login   { username, password }
//   POST /api/account/logout
//   GET  /api/account/sync    -> { rev, data }               (needs sign-in)
//   PUT  /api/account/sync    { data } -> { rev }            (needs sign-in)

import express from 'express';
import { AccountError, SESSION_DAYS } from './accounts.js';

const COOKIE = 'pd_session';
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60_000;

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function accountRouter(accounts) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(express.json({ limit: '1mb' }));

  // A page on another site must not be able to change your data: for anything that isn't a read, the
  // request has to come from this server's own address (browsers always send Origin on these).
  router.use((req, res, next) => {
    if (req.method === 'GET') return next();
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Not allowed.' });
    next();
  });

  const setCookie = (req, res, token) => {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_DAYS * 86_400_000 });
  };
  const userKey = (req) => accounts.userFor(readCookie(req, COOKIE));
  const requireUser = (req, res, next) => {
    const key = userKey(req);
    if (!key) return res.status(401).json({ error: 'Sign in first.' });
    req.userKey = key;
    next();
  };

  // Too many wrong passwords from one place for one name: wait before trying again.
  const fails = new Map();
  const failKey = (req, username) => `${req.ip}|${String(username).toLowerCase()}`;
  const blocked = (key) => {
    const f = fails.get(key);
    if (!f) return false;
    if (f.resetAt < Date.now()) { fails.delete(key); return false; }
    return f.count >= FAIL_LIMIT;
  };
  const noteFail = (key) => {
    const f = fails.get(key);
    if (!f || f.resetAt < Date.now()) fails.set(key, { count: 1, resetAt: Date.now() + FAIL_WINDOW_MS });
    else f.count++;
  };

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof AccountError) return res.status(err.status).json({ error: err.message });
      console.error('[account]', err.message);
      res.status(500).json({ error: 'Something went wrong on the server.' });
    }
  };

  router.get('/', (req, res) => {
    const key = userKey(req);
    res.json({ user: key ? accounts.name(key) : null, signup: accounts.signupOpen });
  });

  router.post('/signup', wrap(async (req, res) => {
    const { username, password } = req.body || {};
    const { user, token } = await accounts.signup(username, password);
    setCookie(req, res, token);
    res.json({ user });
  }));

  router.post('/login', wrap(async (req, res) => {
    const { username, password } = req.body || {};
    const key = failKey(req, username);
    if (blocked(key)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
    try {
      const { user, token } = await accounts.login(username, password);
      fails.delete(key);
      setCookie(req, res, token);
      res.json({ user });
    } catch (err) {
      if (err instanceof AccountError && err.status === 401) noteFail(key);
      throw err;
    }
  }));

  router.post('/logout', (req, res) => {
    accounts.logout(readCookie(req, COOKIE));
    res.clearCookie(COOKIE, { path: '/' });
    res.status(204).end();
  });

  // ?since=<rev> is the cheap check the page repeats: if nothing changed, only the revision comes back.
  router.get('/sync', requireUser, (req, res) => {
    const current = accounts.getData(req.userKey);
    res.json(req.query.since !== undefined && Number(req.query.since) === current.rev ? { rev: current.rev } : current);
  });
  router.put('/sync', requireUser, wrap((req, res) => {
    res.json(accounts.setData(req.userKey, req.body?.data));
  }));

  // Bad JSON, or a body over the limit.
  router.use((err, _req, res, _next) => res.status(err.status || 400).json({ error: 'Bad request.' }));
  return router;
}
