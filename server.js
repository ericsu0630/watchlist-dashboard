// Local portfolio dashboard server.
// - Serves the UI from ./public
// - GET /api/search?q=...  -> TradingView symbol search
// - WebSocket /ws          -> live candles + quotes for the symbols the page is showing
//
// Run:  npm start          (live TradingView data)
//       npm run demo       (synthetic data, no network needed)

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createTradingViewSource } from './lib/tv-source.js';
import { createDemoSource } from './lib/demo-source.js';
import { TIMEFRAMES, DEFAULT_TIMEFRAME } from './public/timeframes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(__dirname, '.env'));

const DEMO = process.argv.includes('--demo') || process.env.DEMO === '1';
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const source = DEMO
  ? createDemoSource()
  : createTradingViewSource({
      credentials: process.env.TV_SESSION && process.env.TV_SIGNATURE
        ? { session: process.env.TV_SESSION, signature: process.env.TV_SIGNATURE }
        : undefined,
    });

// ---------------------------------------------------------------- HTTP
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// Third-party files come straight from node_modules and only change on `npm update`, so let the browser cache them.
const vendorCache = { maxAge: '7d' };
app.get('/vendor/lightweight-charts.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js'), vendorCache);
});
for (const family of ['barlow-semi-condensed', 'inter-tight']) {
  app.use(`/fonts/${family}`, express.static(path.join(__dirname, `node_modules/@fontsource/${family}/files`), vendorCache));
}
app.get('/api/config', (_req, res) => res.json({ demo: DEMO }));
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const results = await source.search(q);
    res.json(results.slice(0, 30));
  } catch (err) {
    console.error('[search]', err.code || '', err.message);
    res.status(502).json({ error: 'Search is unavailable right now. Check your internet connection.' });
  }
});

const server = createServer(app);

// ---------------------------------------------------------------- Streams
// One upstream stream per (symbol, timeframe) for candles and one per symbol
// for quotes, shared by every open browser tab and reference counted.

// How long a stream keeps running after its last tab stops watching it, so switching back
// to an interval (or re-adding a symbol) is instant instead of reloading from TradingView.
const LINGER_MS = 60_000;

const FATAL = new Set(['SYMBOL_ERROR', 'SERIES_ERROR', 'INVALID_ARGUMENT', 'CRITICAL_ERROR', 'NO_DATA', 'QUOTE_ERROR']);

class Stream {
  constructor(key, startFn) {
    this.key = key;
    this.startFn = startFn;
    this.sockets = new Set();
    this.handle = null;
    this.retry = 0;
    this.timer = null;
    this.error = null;
    // Last messages, replayed to newly joined sockets. Values are JSON strings,
    // or functions that build one (so large snapshots are only serialized when needed).
    this.cache = {};
  }
  add(ws) {
    clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
    this.sockets.add(ws);
    for (const entry of Object.values(this.cache)) sendRaw(ws, typeof entry === 'function' ? entry() : entry);
    if (this.error) send(ws, this.error);
    if (!this.handle && !this.timer) this.start();
  }
  remove(ws) {
    this.sockets.delete(ws);
    if (this.sockets.size === 0 && !this.lingerTimer) this.lingerTimer = setTimeout(() => this.stop(), LINGER_MS);
  }
  // Serializes once, however many tabs are listening.
  broadcast(msg, cacheAs) {
    const raw = JSON.stringify(msg);
    if (cacheAs) this.cache[cacheAs] = raw;
    for (const ws of this.sockets) sendRaw(ws, raw);
  }
  async start() {
    this.timer = null;
    const token = (this.token = {});
    try {
      const handle = await this.startFn(this);
      if (token !== this.token || this.sockets.size === 0) return handle.stop();
      this.handle = handle;
      this.retry = 0;
      this.error = null;
      handle.closed?.then(() => {
        if (this.handle !== handle) return;
        this.handle = null;
        // Upstream stopped (disconnect, sleep, network loss): reconnect unless the symbol itself is bad.
        if (this.sockets.size && !this.error && !this.timer) this.scheduleRetry();
      });
    } catch (err) {
      if (token !== this.token) return;
      if (!this.fail(err) && this.sockets.size) {
        const [kind, symbol, tf] = this.key.split('|');
        if (kind === 'bars') this.broadcast({ type: 'retrying', symbol, tf, message: 'Can’t reach TradingView. Retrying' });
        this.scheduleRetry();
      }
    }
  }
  // Returns true when the error is permanent for this symbol (no retry).
  fail(err) {
    const code = err?.code || 'ERROR';
    console.error(`[${this.key}]`, code, err?.message);
    if (FATAL.has(code)) {
      this.error = this.errorMessage(code, err);
      this.broadcast(this.error);
      return true;
    }
    return false;
  }
  scheduleRetry() {
    clearTimeout(this.timer);
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++) + Math.random() * 500;
    this.timer = setTimeout(() => this.start(), delay);
  }
  stop() {
    this.token = null;
    clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
    clearTimeout(this.timer);
    this.timer = null;
    const h = this.handle;
    this.handle = null;
    this.cache = {};
    this.error = null;
    h?.stop().catch(() => {});
    streams.delete(this.key);
  }
}

const streams = new Map();

function candleStream(symbol, tf) {
  const key = `bars|${symbol}|${tf}`;
  if (streams.has(key)) return streams.get(key);
  const preset = TIMEFRAMES.find((t) => t.id === tf) || TIMEFRAMES.find((t) => t.id === DEFAULT_TIMEFRAME);
  const s = new Stream(key, async (stream) => {
    let prevLastTime = null;
    const handle = await source.watchCandles(symbol, preset.interval, preset.count, {
      onData(candles) {
        const lastTime = candles.at(-1)?.time;
        // Same series and only the latest one or two bars moved: send just the tail.
        const tail = prevLastTime != null && (lastTime === prevLastTime || candles.at(-2)?.time === prevLastTime);
        prevLastTime = lastTime;
        // New tabs get the full snapshot, built only when one actually joins.
        let fullRaw = null;
        const full = () => (fullRaw ??= JSON.stringify({ type: 'bars', symbol, tf, full: true, bars: candles.map(toBar) }));
        stream.cache.bars = full;
        if (!stream.sockets.size) return;
        const raw = tail ? JSON.stringify({ type: 'bars', symbol, tf, full: false, bars: candles.slice(-2).map(toBar) }) : full();
        for (const ws of stream.sockets) sendRaw(ws, raw);
      },
      onError(err) {
        stream.fail(err);
      },
    });
    if (handle.info) stream.broadcast({ type: 'info', symbol, info: pickInfo(handle.info) }, 'info');
    return handle;
  });
  s.errorMessage = (code) => ({
    type: 'error', symbol, tf, code,
    message: code === 'SYMBOL_ERROR' ? 'Symbol not found on TradingView.'
      : code === 'NO_DATA' ? 'No price history for this timeframe.'
      : code === 'SERIES_ERROR' ? 'This timeframe is not available without a TradingView login.'
      : 'Chart data was refused for this symbol.',
  });
  streams.set(key, s);
  return s;
}

function quoteStream(symbol) {
  const key = `quote|${symbol}`;
  if (streams.has(key)) return streams.get(key);
  const s = new Stream(key, async (stream) => {
    return source.watchQuote(symbol, {
      onData(quote) {
        stream.broadcast({ type: 'quote', symbol, quote: pickQuote(quote) }, 'quote');
      },
      onError(err) {
        stream.fail(err);
      },
    });
  });
  // A failed quote should not show an error on the tile; the chart still works.
  s.errorMessage = (code) => ({ type: 'quote_error', symbol, code });
  streams.set(key, s);
  return s;
}

function toBar(c) {
  return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 };
}
function pickInfo(i) {
  return {
    description: i.description, exchange: i.exchange, listed_exchange: i.listed_exchange,
    pro_name: i.pro_name, currency_code: i.currency_code, type: i.type, pricescale: i.pricescale, minmov: i.minmov,
  };
}
function pickQuote(q) {
  return {
    lp: q.lp, ch: q.ch, chp: q.chp, currency_code: q.currency_code, description: q.description,
    exchange: q.exchange, short_name: q.short_name, pricescale: q.pricescale,
    current_session: q.current_session, update_mode: q.update_mode, lp_time: q.lp_time,
  };
}

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.subs = new Map(); // key -> Stream
  send(ws, { type: 'hello', demo: DEMO });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'watch' || !Array.isArray(msg.symbols)) return;
    const tf = TIMEFRAMES.some((t) => t.id === msg.tf) ? msg.tf : DEFAULT_TIMEFRAME;
    const symbols = [...new Set(msg.symbols.filter((s) => typeof s === 'string' && /^[\w.!&\-]+:[\w.!&\-]+$/.test(s)))].slice(0, 80);

    const wanted = new Map();
    for (const sym of symbols) {
      wanted.set(`bars|${sym}|${tf}`, () => candleStream(sym, tf));
      wanted.set(`quote|${sym}`, () => quoteStream(sym));
    }
    for (const [key, stream] of ws.subs) {
      if (!wanted.has(key)) { stream.remove(ws); ws.subs.delete(key); }
    }
    for (const [key, make] of wanted) {
      if (ws.subs.has(key)) continue;
      const stream = make();
      ws.subs.set(key, stream);
      stream.add(ws);
    }
  });

  ws.on('close', () => {
    for (const stream of ws.subs.values()) stream.remove(ws);
    ws.subs.clear();
  });
});

function send(ws, msg) {
  sendRaw(ws, JSON.stringify(msg));
}
function sendRaw(ws, raw) {
  if (ws.readyState === 1) ws.send(raw);
}

server.listen(PORT, HOST, () => {
  console.log(`\n  Portfolio dashboard running at http://localhost:${PORT}${DEMO ? '  (demo data)' : ''}\n`);
});

const shutdown = async () => {
  for (const s of [...streams.values()]) s.stop();
  await source.close?.();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
