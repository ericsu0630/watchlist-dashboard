// Remembers symbol searches for a while and lets simultaneous identical searches share one request,
// so typing the same thing again (or several tabs at once) doesn't ask TradingView every time.

export function createSearchCache(search, { ttlMs = 10 * 60_000, maxEntries = 200, now = Date.now } = {}) {
  const done = new Map(); // key -> { at, results }, oldest first
  const pending = new Map(); // key -> Promise of the request in flight

  function remember(key, results) {
    done.delete(key);
    done.set(key, { at: now(), results });
    for (const [k, entry] of done) {
      if (done.size <= maxEntries && now() - entry.at < ttlMs) {
        break;
      }
      done.delete(k);
    }
  }

  return {
    get(text) {
      const key = text.trim().toLowerCase().replace(/\s+/g, ' ');
      const hit = done.get(key);
      if (hit && now() - hit.at < ttlMs) {
        return Promise.resolve(hit.results);
      }
      if (pending.has(key)) {
        return pending.get(key);
      }
      const request = search(text)
        .then((results) => {
          remember(key, results);
          return results;
        })
        .finally(() => pending.delete(key));
      pending.set(key, request);
      return request;
    },
  };
}
