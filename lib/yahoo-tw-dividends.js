// Dividend history for Taiwan listings from Yahoo股市 (tw.stock.yahoo.com): ex-dividend dates,
// cash and stock amounts, and payment dates. TradingView-API has no dividend data.
// Unofficial: this is the JSON behind Yahoo股市's own dividend page (checked live on 24 Nov 2026).

import { yahooTicker } from './yahoo-tw-news.js';

const URL_BASE = 'https://tw.stock.yahoo.com/_td-stock/api/resource/StockServices.dividends;limit=100;sortBy=-date;symbol=';
const HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5',
  Referer: 'https://tw.stock.yahoo.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
};
const TIMEOUT_MS = 8_000;

/** Yahoo code for a Taiwan listing that can pay dividends (not TAIEX), or null. */
export function yahooDividendTicker(symbol) {
  if (/:TAIEX$/.test(symbol)) {
    return null;
  }
  return yahooTicker(symbol);
}

const day = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);
const amount = (v) => {
  const n = Number(v);
  return v != null && v !== '' && v !== '-' && Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Turns Yahoo's answer into [{ exDate, cash, stock, payDate, stockPayDate, period }], oldest first.
 * Dates are 'YYYY-MM-DD' (Taipei calendar); amounts are per share, in TWD.
 */
export function parseYahooDividends(data) {
  if (!data || typeof data !== 'object') {
    throw Object.assign(new Error('unexpected dividend data'), { code: 'PARSE_ERROR' });
  }
  if (data.dividends == null) {
    return []; // indices and symbols without dividends answer {}
  }
  if (!Array.isArray(data.dividends)) {
    throw Object.assign(new Error('unexpected dividend data'), { code: 'PARSE_ERROR' });
  }
  const events = [];
  for (const row of data.dividends) {
    const cashPart = row?.exDividend || {};
    const stockPart = row?.exRight || {};
    const exDate = day(cashPart.date) || day(stockPart.date) || day(row?.exDate);
    const cash = amount(cashPart.cash);
    const stock = amount(stockPart.stock);
    if (!exDate || (cash == null && stock == null)) {
      continue;
    }
    events.push({
      exDate, cash, stock,
      payDate: day(cashPart.cashPayDate),
      stockPayDate: day(stockPart.stockPayDate),
      period: typeof row.period === 'string' ? row.period : null,
    });
  }
  return events.sort((a, b) => a.exDate.localeCompare(b.exDate));
}

/** Dividend history for a Taiwan symbol (TWSE:0056), or [] for anything else. */
export async function fetchYahooDividends(symbol) {
  const code = yahooDividendTicker(symbol);
  if (!code) {
    return [];
  }
  const res = await fetch(URL_BASE + encodeURIComponent(code), { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) {
    return []; // Yahoo doesn't know the symbol, or it has never paid a dividend
  }
  if (!res.ok) {
    throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'HTTP_ERROR' });
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw Object.assign(new Error('unexpected dividend data'), { code: 'PARSE_ERROR' });
  }
  return parseYahooDividends(data);
}
