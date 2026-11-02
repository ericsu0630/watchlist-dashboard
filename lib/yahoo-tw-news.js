// Traditional Chinese (zh-TW) headlines for Taiwan listings from Yahoo股市 (tw.stock.yahoo.com),
// which covers TWSE and TPEX stocks far more thoroughly than English sources.
// There is no public per-stock feed, so this reads the news list that the stock's
// news page (e.g. /quote/2330.TW/news) embeds as data. Checked live on 2 Nov 2026.
// Unofficial: if Yahoo changes the page, this source fails and the others carry on.

import { yahooTicker } from './yahoo-news.js';

const HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
};

/**
 * Pulls the object assigned to `root.App.main` out of the page. It is a JavaScript
 * object literal rather than strict JSON (it contains bare `undefined`), so this scans
 * it brace by brace, respecting strings, and turns `undefined` into `null`.
 */
export function extractAppMain(html) {
  const at = html.indexOf('root.App.main = ');
  if (at < 0) return null;
  let i = html.indexOf('{', at);
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false, out = '', seg = i;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
    else if (c === 'u' && html.startsWith('undefined', i)) { out += `${html.slice(seg, i)}null`; i += 8; seg = i + 1; }
  }
  return JSON.parse(out + html.slice(seg, i + 1));
}

/** The news stream's items from the page data, ads removed. */
export function newsItemsFromPage(main) {
  const stores = main?.context?.dispatcher?.stores || {};
  for (const store of [stores.StreamStore, stores.ApacStreamStore]) {
    const streams = store?.streams || {};
    const key = Object.keys(streams).find((k) => k.startsWith('CUSTOM:NEWS'));
    const items = key && streams[key]?.data?.stream_items;
    if (Array.isArray(items)) return items.filter((it) => it && it.type === 'article' && it.title);
  }
  return null;
}

export async function yahooTwNews(symbol) {
  const t = yahooTicker(symbol);
  if (!t) return [];
  const res = await fetch(`https://tw.stock.yahoo.com/quote/${encodeURIComponent(t)}/news`, { headers: HEADERS, signal: AbortSignal.timeout(8500) });
  if (!res.ok) throw Object.assign(new Error(`Yahoo股市 HTTP ${res.status}`), { code: 'HTTP_ERROR' });
  const main = extractAppMain(await res.text());
  const items = main && newsItemsFromPage(main);
  if (!items) throw Object.assign(new Error('Yahoo股市 page layout not recognised'), { code: 'PARSE_ERROR' });
  return items.map((it) => {
    const ms = Number(it.pubtime);
    if (!Number.isFinite(ms)) return null;
    const url = typeof it.url === 'string' && it.url ? new URL(it.url, 'https://tw.stock.yahoo.com').href : null;
    return {
      id: `yahootw:${it.id || url || it.title}`,
      title: String(it.title).trim(),
      source: it.publisher ? `${it.publisher} via Yahoo股市` : 'Yahoo股市',
      published: Math.floor(ms > 1e12 ? ms / 1000 : ms),
      url,
      symbols: [symbol],
      lang: 'zh-TW',
    };
  }).filter(Boolean);
}
