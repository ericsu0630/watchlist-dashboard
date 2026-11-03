// Live prices for Taiwan listings from Yahoo股市 (tw.stock.yahoo.com). Free TradingView
// data for TWSE and TPEX is 15 minutes behind; Yahoo's is a few seconds old.
// One shared poller asks for every watched Taiwan symbol in a single request.
// Unofficial: this is the JSON the Yahoo股市 site itself loads (checked live on 3 Nov 2026).
// If it fails, tiles quietly fall back to TradingView's delayed price.

import { yahooTicker } from './yahoo-tw-news.js';

const URL_BASE = 'https://tw.stock.yahoo.com/_td-stock/api/resource/StockServices.stockList;fields=avgPrice;symbols=';
const HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5',
  Referer: 'https://tw.stock.yahoo.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
};
const OPEN_MS = 5_000; // while any watched market is open
const CLOSED_MS = 60_000; // after the close nothing moves, so check rarely
const FAIL_MS = [30_000, 60_000, 120_000, 300_000]; // backoff after failed requests
const BATCH = 30; // symbols per request
const TIMEOUT_MS = 4_000;

// Symbols whose Yahoo code doesn't follow the ticker.TW pattern.
const SPECIAL = { 'TWSE:TAIEX': '^TWII' };

/** Yahoo code for live quotes (TWSE:2330 -> 2330.TW, TPEX:6488 -> 6488.TWO, TWSE:TAIEX -> ^TWII), or null. */
export function yahooQuoteTicker(symbol) {
  return SPECIAL[symbol] || yahooTicker(symbol);
}

const watchers = new Map(); // Yahoo code -> Set of callbacks
let timer = null;
let failures = 0;
let running = false;

/** Calls onQuote({ lp, ch, chp, time, open, at }) whenever Yahoo has a price. Returns an unsubscribe function. */
export function watchYahooQuote(symbol, onQuote) {
  const code = yahooQuoteTicker(symbol);
  if (!code) return () => {};
  if (!watchers.has(code)) watchers.set(code, new Set());
  watchers.get(code).add(onQuote);
  if (!running) schedule(0);
  else if (failures === 0) schedule(300); // fetch the new symbol soon, batched with any others added now
  return () => {
    const set = watchers.get(code);
    set?.delete(onQuote);
    if (set && !set.size) watchers.delete(code);
    if (!watchers.size) { clearTimeout(timer); timer = null; running = false; }
  };
}

function schedule(ms) {
  running = true;
  clearTimeout(timer);
  timer = setTimeout(poll, ms);
}

async function poll() {
  timer = null;
  const codes = [...watchers.keys()];
  if (!codes.length) { running = false; return; }
  let anyOpen = false;
  try {
    for (let i = 0; i < codes.length; i += BATCH) {
      for (const q of await fetchQuotes(codes.slice(i, i + BATCH))) {
        if (q.open) anyOpen = true;
        for (const fn of watchers.get(q.code) || []) fn(q);
      }
    }
    if (failures) console.log('[yahoo quotes] working again');
    failures = 0;
  } catch (err) {
    // Log the first failure of a streak only, so a long outage doesn't flood the console.
    if (!failures) console.warn('[yahoo quotes] live Taiwan prices unavailable, using TradingView (delayed):', err.message);
    failures++;
  }
  if (!watchers.size) { running = false; return; }
  schedule(failures ? FAIL_MS[Math.min(failures, FAIL_MS.length) - 1] : anyOpen ? OPEN_MS : CLOSED_MS);
}

async function fetchQuotes(codes) {
  const res = await fetch(URL_BASE + encodeURIComponent(codes.join(',')), { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('unexpected response');
  const at = Date.now();
  const out = [];
  for (const row of data) {
    const lp = Number(row?.price?.raw);
    const prev = Number(row?.regularMarketPreviousClose?.raw);
    if (!row?.symbol || !Number.isFinite(lp) || lp <= 0) continue; // no trade yet, or not a symbol Yahoo knows
    const ch = Number.isFinite(prev) && prev > 0 ? lp - prev : Number(row?.change?.raw);
    out.push({
      code: row.symbol,
      lp,
      ch: Number.isFinite(ch) ? ch : null,
      chp: Number.isFinite(ch) && prev > 0 ? (ch / prev) * 100 : null,
      time: Date.parse(row.regularMarketTime) / 1000 || null,
      open: row.marketStatus === 'open',
      at,
    });
  }
  return out;
}
