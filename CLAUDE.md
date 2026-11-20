# CLAUDE.md

Guidance for Claude sessions working on this repo. The user-facing docs are in `README.md` (features, settings, file map). Read that first.

## What this is

Eric's personal, local-only watchlist: a grid of live candlestick charts grouped into tabs, with a News view and an enlarged interactive chart. Node + Express + `ws` server (`server.js`, `lib/`) and a vanilla ES-module front end (`public/`). There is no build step and no framework.

- `npm start`: live data on http://localhost:3000 (TradingView via `@mathieuc/tradingview` v4; Taiwan listings also use Yahoo股市).
- `npm run demo`: simulated data (`lib/demo-source.js`), with no network needed. `PORT=3123 npm run demo` is what the tests expect.
- Node ≥ 20.19. Lightweight Charts v5 is served from `node_modules` as `/vendor/lightweight-charts.js`.

## Workflow rules (Eric's standing instructions)

- **Commit and push every change without asking.** Make one change per commit, with a descriptive message, so each change can be reverted on its own. Branch `main` on github.com/ericsu0630/watchlist-dashboard. Never force-push unless asked.
- **Author email:** `36872654+ericsu0630@users.noreply.github.com`, never a personal address.
- **Eric commits too.** Pull and read new commits before starting, and build on his changes.
- Server-side changes (`server.js`, `lib/`) need a server restart (Ctrl+C, `npm start`). Page-only changes need a browser refresh. Say which one applies.
- Keep `README.md` in step with features. Write plain, short user-facing text.
- When working on Eric's Mac through the desktop link (`~/claude/dashboard`), git needs delete permission for its lock files. Probe first (`touch`/`rm` a file in `.git`), ask at most once per session, and if a lock is left behind, rename it out of the way instead of asking again.

## Testing

The regression suite is **not in git**. It lives in `.claude-tests/` (git-ignored through `.git/info/exclude`) in Eric's local copy; see its README.

- Setup: put a copy of the repo at `/home/claude/dashboard` and `npm install` there (the scripts import from that path). Start `PORT=3123 npm run demo`, then run `bash .claude-tests/run-all.sh <folder holding the scripts>`. It prints `ALL PASS` or `SOME FAILED`.
- Browser tests are Playwright `.cjs` files against the demo server. `?debug` exposes `window.__watchlist = { tiles, state }`.
- Server tests start `server.js` with `PD_TEST_SOURCE=<module>` (a fake data source). `conn.mjs` and `intraday.mjs` unit-test `lib/`.
- Run the suite before and after each change. Add a test for new behaviour. When a behaviour change is intentional, update the old test and say so. Copy new or changed tests back into `.claude-tests/`.
- Test UI work at desktop and phone widths. Don't change Eric's own board, localStorage or settings during live checks unless he asks.

## Architecture notes that aren't obvious from the code

- **Streams:** one upstream candle stream per (symbol, interval), reference-counted across browser tabs and kept warm for 60 s after the last viewer leaves. A new viewer gets a full snapshot (serialized lazily, once). After that only the last 1–2 bars are sent, and a message identical to the previous one is skipped. Only the active tab's symbols stream.
- **Watch protocol:** the page sends `{ type: 'watch', symbols, tf, viewer?: { symbol, tf } }`. `viewer` adds one extra stream for the enlarged chart only when its interval differs from the board's.
- **One TradingView connection** (`lib/tv-connection.js`). The connection counts as lost after 30 s of silence or when the Mac wakes from sleep. It reconnects with backoff, logs one line down and one line up, and streams wait on `whenUp()` and resume 6 at a time. Keep logs quiet: use `warnEvery` (`lib/log.js`) for anything that repeats.
- **Taiwan data:** free TradingView data for TWSE and TPEX is 15 min delayed.
  - Yahoo股市 supplies prices (polled every 5 s while the market is open) and today's 1H/4H candles from minute data. Its endpoints are unofficial.
  - Ticker mapping: `TWSE:x` → `x.TW`, `TPEX:x` → `x.TWO`, and TAIEX (`TWSE:TAIEX` / `INDEX:TAIEX`) → `^TWII`.
  - Candle boundaries follow TradingView: 1H candles start on the hour from 09:00, and 4H candles start at 09:00 and 13:00 Taipei time.
  - If Yahoo goes stale, data falls back to TradingView.
- **Front end:** `public/app.js` is only the entry point; the code is in `public/app/*.js` (ES modules, one per part: `state.js` has tabs (`pd.tabs` in localStorage), `tile.js` has `Tile extends CandleSeries`, plus the enlarged chart, sorting (per tab; day-change sorts re-sort at most once a minute), news, import/export and keyboard shortcuts). The modules import each other in circles, so they only declare things at load and each exports a `setupX()` that registers its listeners; `app.js` calls them in a fixed order. Keep it that way: don't use another module's exports at the top level of a module. Tile charts are only built near the viewport. All colours are CSS custom properties at the top of `public/styles.css`, and the charts read theirs from the same place.
- Design rules: every chart shows candles at the same width (one global slider), the interval buttons set the candle interval rather than a date range, and the theme is neutral greys.

## More context

If the session is attached to the claude.ai project "Investment Portfolio Dashboard", read:
- `claude/working-agreements.md`: how pushing works, and the **Open work** list (the optimization pass, fixes 2–7).
- `claude/design-spec.md`: the full visual and behaviour spec, with a decisions log.
