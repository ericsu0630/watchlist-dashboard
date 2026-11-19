// The one TradingView connection that every chart and price shares, and what happens when it drops.
//
// Losing the connection (network blip, Wi-Fi change, the Mac sleeping) is handled here, once, for
// everything: one line in the log when it goes, one when it's back, and a single reconnect loop with
// a growing pause between attempts. Charts and prices don't retry on their own while it's down; they
// wait for `whenUp()` and then resume.

import { TradingViewClient } from '@mathieuc/tradingview';

// Codes that mean "the connection", not "this symbol".
const CONNECTION_CODES = new Set(['CONNECTION_ERROR', 'DISCONNECTED', 'OFFLINE']);

const DEFAULTS = {
  // Pause before each reconnect attempt (±20% jitter); the last value repeats.
  reconnectMs: [1000, 2000, 5000, 10_000, 20_000, 30_000, 60_000],
  // TradingView sends a heartbeat about every 10 s, so 30 s of silence means the connection is gone
  // (the library's default waits 60 s).
  inactivityMs: 30_000,
  // During a long outage, a reminder in the log at most this often.
  stillDownLogMs: 5 * 60_000,
  // A 5-second timer that fires this late means the computer was asleep: reconnect straight away
  // rather than waiting for the silence timer.
  wakeCheckMs: 5_000,
  wakeGapMs: 30_000,
};

export function createConnection({ credentials, log = console, Client = TradingViewClient, ...options } = {}) {
  const o = { ...DEFAULTS, ...options };
  let client = null;
  let state = 'idle'; // idle (not connected yet) · up · down (reconnecting)
  let everUp = false;
  let downSince = 0, downReason = '', attempt = 0, retryTimer = null, lastReminder = 0;
  let waiters = [];

  function open() {
    const c = new Client({ credentials, inactivityTimeoutMs: o.inactivityMs });
    client = c;
    c.on('ready', () => { if (c === client) up(); });
    c.on('error', (err) => {
      if (c !== client) return;
      // Connection problems (and a connection that never got ready) are reported once, by down().
      if (CONNECTION_CODES.has(err?.code) || err?.code === 'TIMEOUT') down(err.message);
      else log.error('[tradingview]', err?.code, err?.message);
    });
    c.on('close', () => {
      if (c !== client) return;
      client = null;
      down(state === 'down' ? '' : 'connection closed');
    });
    return c;
  }

  function down(reason, message) {
    reason = reason.replace(/\b(\d{4,}) ms\b/, (_, n) => duration(Number(n))); // "for 30000 ms" -> "for 30 s"
    if (state !== 'down') {
      state = 'down';
      downSince = Date.now();
      lastReminder = downSince;
      downReason = reason;
      attempt = 0;
      log.warn(message || (everUp
        ? `[tradingview] connection lost (${reason}); reconnecting in the background`
        : `[tradingview] can't reach TradingView (${reason}); retrying in the background`));
    } else if (reason) {
      downReason = reason;
    }
    // Let go of the dead connection (its charts and prices are already failing over) and try again shortly.
    if (client) {
      const c = client;
      client = null;
      Promise.resolve().then(() => c.close()).catch(() => {});
    }
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (retryTimer || state !== 'down') return;
    const base = o.reconnectMs[Math.min(attempt, o.reconnectMs.length - 1)];
    retryTimer = setTimeout(() => {
      retryTimer = null;
      attempt++;
      const now = Date.now();
      if (now - lastReminder >= o.stillDownLogMs) {
        lastReminder = now;
        const every = o.reconnectMs.at(-1) / 1000;
        log.warn(`[tradingview] still offline after ${duration(now - downSince)} (${downReason}); trying every ${every} s`);
      }
      open();
    }, base * (0.8 + Math.random() * 0.4));
  }

  function up() {
    clearTimeout(retryTimer);
    retryTimer = null;
    const was = state;
    state = 'up';
    everUp = true;
    if (was === 'down') log.log(`[tradingview] reconnected after ${duration(Date.now() - downSince)}`);
    const resolve = waiters;
    waiters = [];
    for (const r of resolve) r();
  }

  // Waking from sleep: the old connection is almost certainly dead, but would take the silence timer
  // to notice. Reconnect now.
  let lastTick = Date.now();
  const wakeTimer = setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (gap >= o.wakeGapMs && state === 'up') down('the computer was asleep', `[tradingview] reconnecting after sleep (${duration(gap)})`);
  }, o.wakeCheckMs);
  wakeTimer.unref?.();

  return {
    /** idle · up · down */
    get state() { return state; },
    /** The client to use. While reconnecting it throws (code OFFLINE): wait for whenUp() instead. */
    get() {
      if (state === 'down') throw Object.assign(new Error('Waiting for the TradingView connection to come back'), { code: 'OFFLINE' });
      return client && !client.isClosed ? client : open();
    },
    /** Resolves when the connection is usable again (at once unless it's down). */
    whenUp() {
      return state === 'down' ? new Promise((r) => waiters.push(r)) : Promise.resolve();
    },
    /** True for errors caused by the connection rather than by a symbol. */
    isConnectionError(err) {
      return CONNECTION_CODES.has(err?.code) || state === 'down';
    },
    async close() {
      clearInterval(wakeTimer);
      clearTimeout(retryTimer);
      retryTimer = null;
      state = 'idle';
      const c = client;
      client = null;
      await c?.close();
    },
  };
}

export function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
