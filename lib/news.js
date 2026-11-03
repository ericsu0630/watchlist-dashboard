// Headlines for the symbols on the board: fetched per symbol from the data source,
// cached for a few minutes, limited to the last 24 hours, and merged so a story
// that mentions several of your symbols, or comes from more than one source,
// appears once with all of them attached.

export const NEWS_WINDOW_HOURS = 24;
// Symbols with nothing in the window get their latest few older headlines instead, so a
// quiet weekend doesn't leave them blank. Older than this, a story isn't worth showing.
const OLDER_PER_SYMBOL = 3;
const OLDER_MAX_DAYS = 14;
const CACHE_MS = 5 * 60_000; // headlines younger than this are used as they are
const STALE_MS = 6 * 3600_000; // older ones (up to this) are shown at once while fresh ones load
const RETRY_MS = 60_000; // failed lookups are retried sooner
const TIMEOUT_MS = 12_000; // sources each stop at 8.5 s; this is a backstop
const CONCURRENCY = 4; // lookups running at once, background refreshes included
const MAX_ITEMS = 300;

export function createNewsService(source) {
  const cache = new Map(); // symbol -> { items, at, pending, error, errorAt }
  const limit = limiter(CONCURRENCY);

  function entryFor(symbol) {
    let e = cache.get(symbol);
    if (!e) cache.set(symbol, (e = { items: null, at: 0, pending: null, error: null, errorAt: 0 }));
    return e;
  }

  // Starts a lookup, or joins the one already running.
  function fetchNow(symbol, e) {
    if (!e.pending) {
      e.pending = limit(() => withTimeout(source.news(symbol), TIMEOUT_MS))
        .then((items) => { e.items = items; e.at = Date.now(); e.error = null; return items; },
          (err) => { e.error = err; e.errorAt = Date.now(); throw err; })
        .finally(() => { e.pending = null; });
      e.pending.catch(() => {}); // a background refresh that fails is reported by the next request
    }
    return e.pending;
  }

  // { items, at, refreshing }. Unless `fresh` is set, headlines up to STALE_MS old come back at once
  // and a refresh starts behind them; with `fresh`, waits for that refresh.
  async function forSymbol(symbol, fresh) {
    const e = entryFor(symbol);
    const age = Date.now() - e.at;
    if (e.items && age < CACHE_MS) return { items: e.items, at: e.at, refreshing: false };
    const usable = e.items && age < STALE_MS;
    const recentlyFailed = e.error && Date.now() - e.errorAt < RETRY_MS;
    if (recentlyFailed && !e.pending) {
      if (usable) return { items: e.items, at: e.at, refreshing: false };
      throw e.error;
    }
    if (usable && !fresh) {
      fetchNow(symbol, e);
      return { items: e.items, at: e.at, refreshing: true };
    }
    try {
      await fetchNow(symbol, e);
      return { items: e.items, at: e.at, refreshing: false };
    } catch (err) {
      if (usable) return { items: e.items, at: e.at, refreshing: false }; // older headlines beat none
      throw err;
    }
  }

  // Fetches headlines for symbols that have none cached (or only very old ones), without waiting.
  function warm(symbols) {
    for (const symbol of symbols) forSymbol(symbol, true).catch(() => {});
  }

  async function headlines(symbols, { fresh = false } = {}) {
    const wanted = new Set(symbols);
    const results = await Promise.all(symbols.map((symbol) =>
      forSymbol(symbol, fresh).then((r) => ({ symbol, ...r }), (error) => ({ symbol, error }))));
    const refreshing = results.some((r) => r.refreshing);
    // When the oldest headlines in this answer were fetched.
    const ats = results.filter((r) => r.at).map((r) => r.at);
    const fetchedAt = Math.floor((ats.length ? Math.min(...ats) : Date.now()) / 1000);

    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - NEWS_WINDOW_HOURS * 3600;
    const olderCutoff = now - OLDER_MAX_DAYS * 86400;
    const stories = new Map();
    const failed = [];
    const recentCount = new Map(symbols.map((s) => [s, 0]));
    const olderPool = new Map(); // symbol -> older items, for symbols that turn out quiet

    // Match on the headline itself, so the same story from several sources shows once.
    const keyOf = (item) => item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() || item.id || item.url;
    const add = (symbol, item, older) => {
      const key = keyOf(item);
      let story = stories.get(key);
      if (!story) {
        story = { id: String(item.id || item.url || key), title: item.title, source: item.source || null, published: item.published, url: item.url || null, lang: item.lang || null, older, symbols: new Set() };
        stories.set(key, story);
      }
      story.symbols.add(symbol);
      // Attach any other symbols on the board that the story is tagged with.
      for (const related of item.symbols || []) if (wanted.has(related)) story.symbols.add(related);
      return story;
    };

    for (const { symbol, items, error } of results) {
      if (error) {
        console.error(`[news ${symbol}]`, error.code || '', error.message);
        failed.push(symbol);
        continue;
      }
      const older = [];
      for (const item of items) {
        if (!item || item.published > now + 3600) continue;
        if (item.published >= cutoff) {
          add(symbol, item, false);
          recentCount.set(symbol, recentCount.get(symbol) + 1);
        } else if (item.published >= olderCutoff) older.push(item);
      }
      olderPool.set(symbol, older);
    }
    // Recent stories credit every board symbol they're tagged with, so count those too.
    for (const s of stories.values()) for (const sym of s.symbols) recentCount.set(sym, Math.max(1, recentCount.get(sym) || 0));

    const olderFor = [];
    for (const symbol of symbols) {
      if (failed.includes(symbol) || recentCount.get(symbol) > 0) continue;
      const pool = (olderPool.get(symbol) || []).sort((a, b) => b.published - a.published);
      const picked = [];
      for (const item of pool) {
        if (picked.length >= OLDER_PER_SYMBOL) break;
        if (picked.some((p) => keyOf(p) === keyOf(item))) continue; // same story from two sources
        picked.push(item);
      }
      for (const item of picked) {
        const story = add(symbol, item, true);
        if (!story.older) story.symbols.add(symbol); // already shown as recent for another symbol
      }
      if (picked.length) olderFor.push(symbol);
    }

    const items = [...stories.values()]
      .sort((a, b) => (a.older - b.older) || (b.published - a.published)) // recent first, then earlier
      .slice(0, MAX_ITEMS)
      .map((s) => ({ ...s, symbols: symbols.filter((sym) => s.symbols.has(sym)) })); // board order
    return { items, failed, olderFor, windowHours: NEWS_WINDOW_HOURS, fetchedAt, refreshing };
  }

  return { headlines, warm };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`No answer after ${ms / 1000} s`), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs at most `n` of the given tasks at once.
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    task().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (task) => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); next(); });
}
