// Dividend history for the symbols on the board, from /api/dividends. Taiwan listings only (Yahoo股市).
import { tiles } from './state.js';

const FRESH_MS = 12 * 3600_000; // dividends change rarely
const RETRY_MS = 10 * 60_000; // after a failed lookup
const GATHER_MS = 300; // collect the tiles that mount together into one request

const known = new Map(); // symbol -> { events, at } or { failedAt }
const queued = new Set();
const inFlight = new Set();
let timer = null;

/** Taiwan listings other than TAIEX: the only ones with dividend data. */
export function hasDividendData(symbol) {
  return /^(TWSE|TPEX):/.test(symbol) && !/:TAIEX$/.test(symbol);
}

/** The dividends already loaded for a symbol: [{ exDate, cash, stock, payDate, stockPayDate, period }]. */
export function dividendsFor(symbol) {
  return known.get(symbol)?.events || [];
}

/** Loads a symbol's dividends unless they're fresh; the tile gets them through setDividends(). */
export function requestDividends(symbol) {
  if (!hasDividendData(symbol) || inFlight.has(symbol)) {
    return;
  }
  const entry = known.get(symbol);
  const now = Date.now();
  if (entry?.events && now - entry.at < FRESH_MS) {
    return;
  }
  if (entry?.failedAt && now - entry.failedAt < RETRY_MS) {
    return;
  }
  queued.add(symbol);
  if (!timer) {
    timer = setTimeout(flush, GATHER_MS);
  }
}

async function flush() {
  timer = null;
  const symbols = [...queued];
  queued.clear();
  for (const symbol of symbols) {
    inFlight.add(symbol);
  }
  let answer = null;
  try {
    const res = await fetch(`/api/dividends?symbols=${encodeURIComponent(symbols.join(','))}`);
    answer = res.ok ? await res.json() : null;
  } catch {
    answer = null;
  }
  const now = Date.now();
  for (const symbol of symbols) {
    inFlight.delete(symbol);
    const events = answer?.dividends?.[symbol];
    if (!Array.isArray(events)) {
      // Keep what we had; ask again later.
      known.set(symbol, { ...known.get(symbol), failedAt: now });
      continue;
    }
    known.set(symbol, { events, at: now });
    tiles.get(symbol)?.setDividends(events);
  }
}
