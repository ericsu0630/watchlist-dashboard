// Yahoo Finance headlines for Taiwan-listed symbols, which TradingView covers thinly.
// TradingView ids map to Yahoo tickers: TWSE:2330 -> 2330.TW, TPEX:6488 -> 6488.TWO.
// Uses Yahoo's search endpoint (the one yahoo.com and yfinance use), falling back to
// the per-ticker RSS feed. Both are unofficial and need no API key.

const YAHOO_SUFFIX = { TWSE: 'TW', TPEX: 'TWO' };
const HEADERS = {
  Accept: 'application/json, application/rss+xml;q=0.9, */*;q=0.5',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
};

/** Yahoo ticker for a TradingView symbol, or null if Yahoo isn't used for it. */
export function yahooTicker(symbol) {
  const [exchange, ticker] = symbol.split(':');
  const suffix = YAHOO_SUFFIX[exchange];
  return suffix && ticker ? `${ticker}.${suffix}` : null;
}

/** TradingView symbol for a Yahoo ticker (Taiwan listings only), or null. */
function fromYahooTicker(t) {
  const m = /^([0-9A-Z]+)\.(TWO|TW)$/i.exec(String(t || ''));
  if (!m) return null;
  return `${m[2].toUpperCase() === 'TWO' ? 'TPEX' : 'TWSE'}:${m[1].toUpperCase()}`;
}

const label = (publisher) => (publisher ? `${publisher} via Yahoo Finance` : 'Yahoo Finance');

function fromSearchItem(raw, symbol) {
  const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
  const published = Number(raw?.providerPublishTime);
  if (!title || !Number.isFinite(published)) return null;
  const related = (raw.relatedTickers || []).map(fromYahooTicker).filter(Boolean);
  return {
    id: raw.uuid ? `yahoo:${raw.uuid}` : null,
    title,
    source: label(raw.publisher),
    published: Math.floor(published > 1e12 ? published / 1000 : published),
    url: raw.link || null,
    symbols: [...new Set([symbol, ...related])],
  };
}

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&')
  .trim();
const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? decode(m[1]) : '';
};

function parseRss(xml, symbol) {
  const items = [];
  for (const [, body] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const title = tag(body, 'title');
    const published = Date.parse(tag(body, 'pubDate')) / 1000;
    if (!title || !Number.isFinite(published)) continue;
    const guid = tag(body, 'guid');
    items.push({ id: guid ? `yahoo:${guid}` : null, title, source: label(tag(body, 'source') || null), published: Math.floor(published), url: tag(body, 'link') || null, symbols: [symbol] });
  }
  return items;
}

export async function yahooNews(symbol) {
  const t = yahooTicker(symbol);
  if (!t) return [];
  const q = encodeURIComponent(t);
  const attempts = [
    { url: `https://query1.finance.yahoo.com/v1/finance/search?q=${q}&quotesCount=0&newsCount=25&enableFuzzyQuery=false`, kind: 'json' },
    { url: `https://query2.finance.yahoo.com/v1/finance/search?q=${q}&quotesCount=0&newsCount=25&enableFuzzyQuery=false`, kind: 'json' },
    { url: `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${q}&region=US&lang=en-US`, kind: 'rss' },
  ];
  let lastError;
  const signal = AbortSignal.timeout(8500); // one budget for all attempts
  for (const { url, kind } of attempts) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal });
      if (!res.ok) throw Object.assign(new Error(`Yahoo HTTP ${res.status}`), { code: 'HTTP_ERROR' });
      if (kind === 'json') {
        const data = await res.json();
        if (!Array.isArray(data?.news)) throw Object.assign(new Error('Unexpected Yahoo response'), { code: 'PARSE_ERROR' });
        return data.news.map((n) => fromSearchItem(n, symbol)).filter(Boolean);
      }
      const xml = await res.text();
      if (!/<rss\b|<channel\b/i.test(xml)) throw Object.assign(new Error('Unexpected Yahoo RSS'), { code: 'PARSE_ERROR' });
      return parseRss(xml, symbol);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
