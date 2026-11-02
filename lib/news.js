// Headlines for the symbols on the board: fetched per symbol from the data source,
// cached for a few minutes, limited to the last 24 hours, and merged so a story
// that mentions several of your symbols, or comes from more than one source,
// appears once with all of them attached.

export const NEWS_WINDOW_HOURS = 24;
const CACHE_MS = 5 * 60_000; // successful lookups
const RETRY_MS = 60_000; // failed lookups are retried sooner
const TIMEOUT_MS = 12_000; // sources each stop at 8.5 s; this is a backstop
const CONCURRENCY = 4;
const MAX_ITEMS = 300;

export function createNewsService(source) {
  const cache = new Map(); // symbol -> { at, failed, promise }

  function forSymbol(symbol) {
    const hit = cache.get(symbol);
    if (hit && Date.now() - hit.at < (hit.failed ? RETRY_MS : CACHE_MS)) return hit.promise;
    const entry = { at: Date.now(), failed: false };
    entry.promise = withTimeout(source.news(symbol), TIMEOUT_MS).catch((err) => {
      entry.failed = true;
      throw err;
    });
    cache.set(symbol, entry);
    return entry.promise;
  }

  async function headlines(symbols) {
    const wanted = new Set(symbols);
    const results = await mapLimit(symbols, CONCURRENCY, (symbol) =>
      forSymbol(symbol).then((items) => ({ symbol, items }), (error) => ({ symbol, error })));

    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - NEWS_WINDOW_HOURS * 3600;
    const stories = new Map();
    const failed = [];
    for (const { symbol, items, error } of results) {
      if (error) {
        console.error(`[news ${symbol}]`, error.code || '', error.message);
        failed.push(symbol);
        continue;
      }
      for (const item of items) {
        if (!item || item.published < cutoff || item.published > now + 3600) continue;
        // Match on the headline itself, so the same story from TradingView and Yahoo shows once.
        const key = item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() || item.id || item.url;
        let story = stories.get(key);
        if (!story) {
          story = { id: String(item.id || item.url || key), title: item.title, source: item.source || null, published: item.published, url: item.url || null, symbols: new Set() };
          stories.set(key, story);
        }
        story.symbols.add(symbol);
        // Attach any other symbols on the board that the story is tagged with.
        for (const related of item.symbols || []) if (wanted.has(related)) story.symbols.add(related);
      }
    }
    const items = [...stories.values()]
      .sort((a, b) => b.published - a.published)
      .slice(0, MAX_ITEMS)
      .map((s) => ({ ...s, symbols: symbols.filter((sym) => s.symbols.has(sym)) })); // board order
    return { items, failed, windowHours: NEWS_WINDOW_HOURS, fetchedAt: now };
  }

  return { headlines };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`No answer after ${ms / 1000} s`), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}
