// For problems that repeat (every symbol, every refresh): one log line per problem per interval,
// with a count of the repeats that were held back.

const seen = new Map(); // key -> { at, held }

export function warnEvery(key, intervalMs, message) {
  const now = Date.now();
  const e = seen.get(key);
  if (e && now - e.at < intervalMs) { e.held++; return; }
  const held = e?.held ? ` (${e.held} more like this since the last report)` : '';
  seen.set(key, { at: now, held: 0 });
  console.warn(message + held);
}
