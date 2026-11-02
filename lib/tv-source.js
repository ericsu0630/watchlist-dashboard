// Live data from TradingView via @mathieuc/tradingview (v4).
// Everything shares one websocket connection, re-created automatically after a
// disconnect. Candles use the data API (one chart session per symbol and
// interval); prices for every symbol go through a single shared quote session.

import { TradingViewClient, watchCandles, searchMarkets } from '@mathieuc/tradingview';
import { yahooNews, yahooTicker } from './yahoo-news.js';

// TradingView's public headline feeds (unofficial, like the rest of this library's data).
// The second is the newer news-flow feed, tried if the first fails.
const NEWS_URLS = (symbol) => [
  `https://news-headlines.tradingview.com/v2/headlines?client=web&lang=en&streaming=false&symbol=${encodeURIComponent(symbol)}`,
  `https://news-mediator.tradingview.com/news-flow/v2/news?filter=lang%3Aen&filter=symbol%3A${encodeURIComponent(symbol)}&client=web&streaming=false`,
];
const NEWS_HEADERS = {
  Accept: 'application/json',
  Origin: 'https://www.tradingview.com',
  Referer: 'https://www.tradingview.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
};

// Maps one feed item to { id, title, source, published (Unix s), url, symbols }; null if unusable.
function normalizeStory(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  let published = raw.published ?? raw.publishedAt ?? raw.date;
  if (typeof published === 'string') published = /^\d+$/.test(published) ? Number(published) : Date.parse(published) / 1000;
  if (typeof published === 'number' && published > 1e12) published /= 1000; // milliseconds
  if (!title || !Number.isFinite(published)) return null;
  const provider = raw.provider;
  const source = raw.source || (typeof provider === 'string' ? provider : provider?.name) || null;
  const url = raw.link || (raw.storyPath ? `https://www.tradingview.com${raw.storyPath}` : null);
  const symbols = (raw.relatedSymbols || raw.symbols || [])
    .map((s) => (typeof s === 'string' ? s : s?.symbol))
    .filter((s) => typeof s === 'string');
  return { id: raw.id ? String(raw.id) : null, title, source, published: Math.floor(published), url, symbols };
}

async function tradingViewNews(symbol) {
  let lastError;
  const signal = AbortSignal.timeout(8500); // one budget for both feeds
  for (const url of NEWS_URLS(symbol)) {
    try {
      const res = await fetch(url, { headers: NEWS_HEADERS, signal });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'HTTP_ERROR' });
      const data = await res.json();
      const items = Array.isArray(data) ? data : data?.items ?? data?.data?.items;
      if (!Array.isArray(items)) throw Object.assign(new Error('Unexpected response shape'), { code: 'PARSE_ERROR' });
      return items.map(normalizeStory).filter(Boolean);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const QUOTE_FIELDS = [
  'lp', 'ch', 'chp', 'lp_time', 'currency_code', 'description', 'exchange', 'short_name',
  'pro_name', 'pricescale', 'current_session', 'update_mode', 'type',
];

export function createTradingViewSource({ credentials } = {}) {
  let client = null;
  let quoteSession = null;

  function getClient() {
    if (!client || client.isClosed) {
      client = new TradingViewClient({ credentials });
      client.on('error', (err) => console.error('[tradingview]', err.code, err.message));
      client.on('close', () => console.warn('[tradingview] connection closed, will reconnect on demand'));
    }
    return client;
  }

  // One quote session for all symbols, recreated along with the connection.
  function getQuoteSession() {
    const c = getClient();
    if (!quoteSession || quoteSession.isDeleted || quoteSession.client !== c) {
      quoteSession = c.createQuoteSession({ fields: QUOTE_FIELDS });
      quoteSession.on('error', (err) => console.error('[tradingview quotes]', err.code, err.message));
    }
    return quoteSession;
  }

  return {
    async search(text) {
      const results = await searchMarkets(text);
      return results.map((r) => ({
        id: r.id,
        symbol: r.symbol,
        exchange: r.exchange,
        description: r.description,
        type: r.type,
        currency: r.currency,
        country: r.country,
      }));
    },

    async watchCandles(symbol, timeframe, count, { onData, onError }) {
      const watcher = await watchCandles(
        { symbol, timeframe, count, client: getClient(), timeoutMs: 25_000 },
        { onData, onError },
      );
      return { stop: () => watcher.stop(), closed: watcher.closed, info: watcher.symbolInfo };
    },

    // Subscribes one symbol on the shared quote session. Resolves once the first quote
    // arrives; `closed` resolves if the connection drops, so the caller can resubscribe.
    async watchQuote(symbol, { onData, onError }) {
      const sub = getQuoteSession().subscribe(symbol);
      let markClosed;
      const closed = new Promise((resolve) => (markClosed = resolve));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          sub.close();
          reject(Object.assign(new Error(`No quote for ${symbol} after 25 s`), { code: 'TIMEOUT' }));
        }, 25_000);
        sub.once('loaded', () => { clearTimeout(timer); resolve(); });
        sub.on('error', (err) => {
          if (!sub.isLoaded) { clearTimeout(timer); sub.close(); reject(err); }
          else if (sub.isClosed) markClosed();
          else onError?.(err);
        });
      });
      sub.on('data', (quote) => onData(quote));
      onData(sub.data);
      return { stop: async () => { sub.close(); markClosed(); }, closed };
    },

    // TradingView headlines for every symbol; Taiwan listings (TWSE, TPEX) also get Yahoo Finance's.
    // Fails only if every source fails for the symbol.
    async news(symbol) {
      const sources = [tradingViewNews(symbol)];
      if (yahooTicker(symbol)) sources.push(yahooNews(symbol));
      const results = await Promise.allSettled(sources);
      const ok = results.filter((r) => r.status === 'fulfilled');
      for (const r of results) if (r.status === 'rejected' && ok.length) console.warn(`[news ${symbol}] one source failed:`, r.reason?.message);
      if (!ok.length) throw results[0].reason;
      return ok.flatMap((r) => r.value);
    },

    async close() {
      await client?.close();
    },
  };
}
