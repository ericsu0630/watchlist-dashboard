// Live data from TradingView via @mathieuc/tradingview (v4 data API).
// All candle and quote watchers share one websocket connection, which is
// re-created automatically after a disconnect.

import { TradingViewClient, watchCandles, watchQuotes, searchMarkets } from '@mathieuc/tradingview';

const QUOTE_FIELDS = [
  'lp', 'ch', 'chp', 'lp_time', 'currency_code', 'description', 'exchange', 'short_name',
  'pro_name', 'pricescale', 'current_session', 'update_mode', 'type',
];

export function createTradingViewSource({ credentials } = {}) {
  let client = null;

  function getClient() {
    if (!client || client.isClosed) {
      client = new TradingViewClient({ credentials });
      client.on('error', (err) => console.error('[tradingview]', err.code, err.message));
      client.on('close', () => console.warn('[tradingview] connection closed, will reconnect on demand'));
    }
    return client;
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

    async watchQuote(symbol, { onData, onError }) {
      const watcher = await watchQuotes(
        { symbols: [symbol], fields: QUOTE_FIELDS, client: getClient(), timeoutMs: 25_000 },
        { onData: (_sym, quote) => onData(quote), onError },
      );
      const initial = watcher.latest[symbol];
      if (initial) onData(initial);
      return { stop: () => watcher.stop(), closed: watcher.closed };
    },

    async close() {
      await client?.close();
    },
  };
}
