// Synthetic market data for `npm run demo`: same interface as tv-source.js,
// no network. Prices are a random walk that ticks every second.

const CATALOG = [
  ['NASDAQ:AAPL', 'Apple Inc.', 'stock', 231], ['NASDAQ:MSFT', 'Microsoft Corporation', 'stock', 512],
  ['NASDAQ:NVDA', 'NVIDIA Corporation', 'stock', 182], ['NASDAQ:AMZN', 'Amazon.com, Inc.', 'stock', 224],
  ['NASDAQ:GOOGL', 'Alphabet Inc. Class A', 'stock', 247], ['NASDAQ:META', 'Meta Platforms, Inc.', 'stock', 738],
  ['NASDAQ:TSLA', 'Tesla, Inc.', 'stock', 441], ['NYSE:TSM', 'Taiwan Semiconductor Manufacturing', 'stock', 296],
  ['NYSE:JPM', 'JPMorgan Chase & Co.', 'stock', 301], ['NYSE:V', 'Visa Inc.', 'stock', 344],
  ['NYSE:BRK.B', 'Berkshire Hathaway Inc. Class B', 'stock', 488], ['NYSE:KO', 'Coca-Cola Company', 'stock', 69],
  ['AMEX:SPY', 'SPDR S&P 500 ETF Trust', 'fund', 671], ['NASDAQ:QQQ', 'Invesco QQQ Trust', 'fund', 604],
  ['AMEX:VTI', 'Vanguard Total Stock Market ETF', 'fund', 329], ['TWSE:2330', 'Taiwan Semiconductor Mfg. Co.', 'stock', 1440],
  ['TWSE:0050', 'Yuanta Taiwan Top 50 ETF', 'fund', 58.4], ['BINANCE:BTCUSDT', 'Bitcoin / TetherUS', 'spot', 112400],
  ['BINANCE:ETHUSDT', 'Ethereum / TetherUS', 'spot', 4120], ['BINANCE:SOLUSDT', 'Solana / TetherUS', 'spot', 196],
  ['FX:EURUSD', 'Euro / U.S. Dollar', 'forex', 1.1632], ['FX:USDJPY', 'U.S. Dollar / Japanese Yen', 'forex', 151.8],
  ['TVC:GOLD', 'Gold', 'commodity', 3980], ['TVC:US10Y', 'US 10 Year Treasury Yield', 'bond', 4.06],
];

const INTERVAL_SECONDS = { 1: 60, 5: 300, 15: 900, 30: 1800, 60: 3600, 240: 14400, D: 86400, W: 604800, M: 2592000, '3M': 7776000 };

function rng(seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

function lookup(symbol) {
  const hit = CATALOG.find((c) => c[0] === symbol);
  if (hit) return hit;
  // Unknown but well-formed symbols get made-up data so anything can be tried in demo mode.
  const r = rng(symbol);
  return [symbol, `${symbol.split(':')[1]} (demo)`, 'stock', Math.round(20 + r() * 400)];
}

const engines = new Map();
function engine(symbol) {
  if (engines.has(symbol)) return engines.get(symbol);
  const [, description, type, base] = lookup(symbol);
  const r = rng(symbol + Date.now());
  const daily = type === 'spot' ? 0.03 : type === 'forex' ? 0.005 : 0.015; // typical daily move
  const vol = daily * Math.sqrt(1 / 23400); // per one-second tick
  const e = {
    symbol, description, type, vol, daily,
    decimals: base < 10 ? 4 : 2,
    price: base,
    prevClose: base * (1 - (r() - 0.45) * 0.04),
    listeners: new Set(),
    timer: null,
  };
  e.timer = setInterval(() => {
    e.price *= 1 + gauss(r) * vol;
    for (const fn of e.listeners) fn(e.price);
  }, 1000);
  engines.set(symbol, e);
  return e;
}
function release(e, fn) {
  e.listeners.delete(fn);
  if (e.listeners.size === 0) { clearInterval(e.timer); engines.delete(e.symbol); }
}

function history(e, step, count) {
  const r = rng(`${e.symbol}|${step}`);
  const barVol = e.daily * Math.sqrt(Math.min(step, 604800) / 86400) * 0.9;
  const now = Math.floor(Date.now() / 1000);
  let t = Math.floor(now / step) * step;
  let p = e.price;
  const bars = [];
  for (let i = 0; i < count; i++, t -= step) {
    const close = p;
    const open = close / (1 + gauss(r) * barVol + barVol * 0.04);
    const high = Math.max(open, close) * (1 + Math.abs(gauss(r)) * barVol * 0.5);
    const low = Math.min(open, close) * (1 - Math.abs(gauss(r)) * barVol * 0.5);
    bars.push({ time: t, open, high, low, close, volume: Math.round((0.4 + r()) * 1e5 * Math.sqrt(step / 300)) });
    p = open;
  }
  return bars.reverse();
}

// Sample headlines for demo mode, clearly marked as coming from a demo feed.
const DEMO_TEMPLATES = [
  '{name} shares move as traders weigh the latest guidance',
  'Analysts revisit their {ticker} price targets',
  'What to watch for {name} this week',
  '{ticker} trading volume picks up into the close',
  'Options activity in {ticker} climbs ahead of key data',
  '{name} draws attention after a busy session',
];
const DEMO_MARKET_SYMBOLS = ['NASDAQ:AAPL', 'NASDAQ:MSFT', 'NASDAQ:NVDA', 'NASDAQ:QQQ', 'AMEX:SPY'];

function demoNews(symbol) {
  const [, description] = lookup(symbol);
  const ticker = symbol.split(':')[1];
  const name = description.replace(/ \/.*$/, '').replace(/,? (Inc\.|Corporation|Trust|ETF Trust).*$/, '');
  const now = Math.floor(Date.now() / 1000);
  const hour = Math.floor(now / 3600);
  const r = rng(`${symbol}|news|${hour}`);
  const count = 2 + Math.floor(r() * 4);
  const items = [];
  for (let i = 0; i < count; i++) {
    const t = DEMO_TEMPLATES[Math.floor(r() * DEMO_TEMPLATES.length)];
    items.push({
      id: `demo-${symbol}-${hour}-${i}`,
      title: t.replace('{name}', name).replace('{ticker}', ticker),
      source: 'Demo feed',
      published: now - Math.floor(r() * 36 * 3600), // some fall outside the 24-hour window on purpose
      url: null,
      symbols: [symbol],
    });
  }
  // Taiwan listings also get "Yahoo Finance" items, one of them repeating a story above,
  // so demo mode shows stories from two sources merging into one.
  if (/^(TWSE|TPEX):/.test(symbol)) {
    items.push({ id: `demo-yahoo-${symbol}-${hour}-dup`, title: items[0].title, source: 'Demo feed via Yahoo Finance', published: items[0].published, url: null, symbols: [symbol] });
    items.push({ id: `demo-yahoo-${symbol}-${hour}`, title: `${name} monthly revenue update draws investor interest`, source: 'Demo feed via Yahoo Finance', published: now - 3 * 3600, url: null, symbols: [symbol] });
  }
  if (DEMO_MARKET_SYMBOLS.includes(symbol)) {
    items.push({ id: `demo-market-${hour}`, title: 'Large-cap tech leads a mixed session for US indices', source: 'Demo feed', published: now - 5400, url: null, symbols: DEMO_MARKET_SYMBOLS });
  }
  return items;
}

export function createDemoSource() {
  return {
    async news(symbol) {
      await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 250));
      return demoNews(symbol);
    },

    async search(text) {
      const q = text.toLowerCase();
      return CATALOG.filter(([id, desc]) => id.toLowerCase().includes(q) || desc.toLowerCase().includes(q))
        .map(([id, description, type]) => {
          const [exchange, symbol] = id.split(':');
          return { id, symbol, exchange, description, type };
        });
    },

    async watchCandles(symbol, timeframe, count, { onData }) {
      const e = engine(symbol);
      const step = INTERVAL_SECONDS[timeframe] || 86400;
      const bars = history(e, step, count);
      let closeResolve;
      const closed = new Promise((res) => (closeResolve = res));
      const fn = (price) => {
        const t = Math.floor(Date.now() / 1000 / step) * step;
        const last = bars.at(-1);
        if (t > last.time) {
          bars.push({ time: t, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price, volume: 0 });
          bars.shift();
        } else {
          last.close = price;
          last.high = Math.max(last.high, price);
          last.low = Math.min(last.low, price);
          last.volume += Math.round(Math.random() * 400 * Math.sqrt(step / 300));
        }
        onData(bars.map((b) => ({ ...b })));
      };
      e.listeners.add(fn);
      onData(bars.map((b) => ({ ...b })));
      const [exchange] = symbol.split(':');
      return {
        info: { description: e.description, exchange, listed_exchange: exchange, pro_name: symbol, type: e.type, pricescale: 10 ** e.decimals, minmov: 1, currency_code: 'USD' },
        closed,
        stop: async () => { release(e, fn); closeResolve(); },
      };
    },

    async watchQuote(symbol, { onData }) {
      const e = engine(symbol);
      const [exchange, short] = symbol.split(':');
      const q = (price) => ({
        lp: price, ch: price - e.prevClose, chp: ((price - e.prevClose) / e.prevClose) * 100,
        description: e.description, exchange, short_name: short, pricescale: 10 ** e.decimals,
        current_session: e.type === 'spot' ? 'market' : 'market', update_mode: 'streaming', currency_code: 'USD',
      });
      let closeResolve;
      const closed = new Promise((res) => (closeResolve = res));
      const fn = (price) => onData(q(price));
      e.listeners.add(fn);
      onData(q(e.price));
      return { closed, stop: async () => { release(e, fn); closeResolve(); } };
    },
  };
}
