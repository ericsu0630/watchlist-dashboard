// Live data from TradingView via @mathieuc/tradingview (v4).
// Everything shares one websocket connection, re-created automatically after a
// disconnect. Candles use the data API (one chart session per symbol and
// interval); prices for every symbol go through a single shared quote session.

import { TradingViewClient, watchCandles, searchMarkets } from '@mathieuc/tradingview';

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

    async close() {
      await client?.close();
    },
  };
}
