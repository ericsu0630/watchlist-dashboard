// Today's intraday candles for Taiwan listings, built from Yahoo股市's minute data.
// Free TradingView TWSE/TPEX candles are 15 minutes late; these are live. Used for the
// 1H and 4H charts (daily-and-up charts follow the live quote instead).
// Unofficial: this is the JSON behind Yahoo股市's own intraday chart (checked live on 9 Nov 2026).
// If it fails, charts quietly fall back to TradingView's delayed candles.

import { yahooQuoteTicker } from './yahoo-tw-quotes.js';

const URL_BASE = 'https://tw.stock.yahoo.com/_td-stock/api/resource/FinanceChartService.ApacLibraCharts;autoRefresh=1;type=tick;symbols=';
const HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5',
  Referer: 'https://tw.stock.yahoo.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
};
const OPEN_MS = 20_000; // while the market is open
const CLOSED_MS = 300_000; // after the close the minutes don't change
const FAIL_MS = [30_000, 60_000, 120_000, 300_000]; // backoff after failed requests
const BATCH = 20; // symbols per request
const TIMEOUT_MS = 8_000;
const TPE = 8 * 3600;
const SESSION_START = 9 * 3600; // TWSE and TPEX open at 09:00 Taipei; TradingView's 1H and 4H candles start there too

const watchers = new Map(); // Yahoo code -> Set of callbacks
let timer = null;
let failures = 0;
let running = false;

/**
 * Calls onMinutes({ minutes, index, at }) whenever Yahoo has the session's minute data for the symbol.
 * `minutes` are [{ time, open, high, low, close, volume }] with `time` the minute's END (Yahoo's stamp),
 * volume in shares (0 for indices). Returns an unsubscribe function.
 */
export function watchYahooMinutes(symbol, onMinutes) {
  const code = yahooQuoteTicker(symbol);
  if (!code) return () => {};
  if (!watchers.has(code)) watchers.set(code, new Set());
  watchers.get(code).add(onMinutes);
  if (!running) schedule(0);
  else if (failures === 0) schedule(300);
  return () => {
    const set = watchers.get(code);
    set?.delete(onMinutes);
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
      for (const d of await fetchMinutes(codes.slice(i, i + BATCH))) {
        if (d.open) anyOpen = true;
        for (const fn of watchers.get(d.code) || []) fn(d);
      }
    }
    if (failures) console.log('[yahoo intraday] working again');
    failures = 0;
  } catch (err) {
    if (!failures) console.warn('[yahoo intraday] live Taiwan intraday candles unavailable, using TradingView (delayed):', err.message);
    failures++;
  }
  if (!watchers.size) { running = false; return; }
  schedule(failures ? FAIL_MS[Math.min(failures, FAIL_MS.length) - 1] : anyOpen ? OPEN_MS : CLOSED_MS);
}

async function fetchMinutes(codes) {
  const res = await fetch(URL_BASE + encodeURIComponent(JSON.stringify(codes)), { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('unexpected response');
  const at = Date.now();
  const out = [];
  for (const row of data) {
    const chart = row?.chart;
    const ts = chart?.timestamp;
    const q = chart?.indicators?.quote?.[0];
    if (!row?.symbol || !Array.isArray(ts) || !q) continue;
    const index = row.symbol.startsWith('^'); // TradingView has no volume for TAIEX, so neither do these
    const minutes = [];
    for (let i = 0; i < ts.length; i++) {
      const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]].map(Number);
      if (![o, h, l, c].every((v) => Number.isFinite(v) && v > 0) || q.close?.[i] == null) continue; // no trade that minute
      const v = Number(q.volume?.[i]);
      minutes.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: index || !Number.isFinite(v) ? 0 : v * 1000 }); // lots of 1,000 shares
    }
    const period = chart.meta?.currentTradingPeriod?.regular;
    const now = at / 1000;
    out.push({ code: row.symbol, minutes, index, at, open: !!period && now >= period.start && now <= period.end + 300 });
  }
  return out;
}

/**
 * Groups minutes into candles of `step` seconds, on TradingView's boundaries: from 09:00 Taipei,
 * so 1H candles start 09:00, 10:00 … 13:00 and 4H candles 09:00 and 13:00. A minute stamped 10:00
 * covers 09:59–10:00 and belongs to the 09:00 candle; the 09:00 opening auction belongs to 09:00.
 */
export function minutesToBars(minutes, step) {
  const bars = [];
  for (const m of minutes) {
    const day = Math.floor((m.time + TPE) / 86400) * 86400 - TPE; // Taipei midnight, as a Unix time
    const sessionStart = day + SESSION_START;
    const start = Math.max(m.time - 60, sessionStart);
    const time = sessionStart + Math.floor((start - sessionStart) / step) * step;
    const last = bars.at(-1);
    if (last && last.time === time) {
      last.high = Math.max(last.high, m.high);
      last.low = Math.min(last.low, m.low);
      last.close = m.close;
      last.volume += m.volume;
    } else if (!last || time > last.time) {
      bars.push({ time, open: m.open, high: m.high, low: m.low, close: m.close, volume: m.volume });
    }
  }
  return bars;
}

/**
 * TradingView's candles with the session Yahoo has (normally today) swapped in, or null when there's
 * nothing to swap: no minutes, or Yahoo's data is older than TradingView's (Yahoo still on an earlier day).
 */
export function mergeLiveBars(tvBars, liveBars) {
  if (!liveBars.length || !tvBars.length) return null;
  if (liveBars.at(-1).time < tvBars.at(-1).time) return null;
  const first = liveBars[0].time;
  return tvBars.filter((b) => b.time < first).concat(liveBars);
}
