# Watchlist: a local portfolio dashboard

A dark, four-column board of live candlestick charts for the symbols you track.
Data comes from TradingView through [TradingView-API](https://github.com/Mathieu2301/TradingView-API).
Charts are drawn with [Lightweight Charts](https://www.tradingview.com/lightweight-charts/).

![The Watchlist dashboard: a dark grid of live candlestick charts for AAPL, BTCUSDT, DXY, ETHUSD, GOOG, MSFT, NFLX, NVDA and SPX, sorted A–Z on 1-hour candles](docs/screenshot.png)

## Run it

You need Node.js 20.19 or newer (`node -v` to check; `brew install node` if you don't have it).

```bash
cd ~/claude/dashboard
npm install
npm start
```

Then open **http://localhost:3000**.

To try the UI without a network connection, run `npm run demo`. It uses simulated prices.

Everything the page needs, fonts included, is served from your machine. Only market data comes from TradingView.

After pulling new changes, run `npm install` again in case dependencies changed, then restart the server.

## Using the board

- **Add a symbol**: press `/` or click the search bar, type a ticker or company name (`AAPL`, `2330`, `bitcoin`), then pick a result with the arrow keys and Enter.
  If you already know the full TradingView id, type it (for example `TWSE:0050`) and press Enter.
- **Candle interval**: the 1H / 4H / 1D / 1W / 1M / 3M switch in the top bar sets what one candle represents on every chart.
  For example, on 1W each candle is one week, and on 3M each candle is one quarter.
- **Candle width**: the slider next to the interval switch sets how wide candles are on every chart, so they always match across tiles.
  It steps from 1 px to 15 px per candle (default 5 px). Slide right for wider candles (fewer on screen) and left for narrower ones (more history). Double-click the slider to reset it.
  Drag left in a chart to see older candles. Because trading hours differ, the same number of hourly or 4-hour candles covers a different stretch of calendar time for a Taiwan stock or a crypto pair than for a US stock.
- **Sort**: the sort button left of the interval switch orders tiles by ticker. Click it to switch between A–Z and Z–A (numbers sort naturally, so 0050 comes before 2330).
  New symbols go into their sorted place. Moving a tile yourself switches the button to Unsorted, and new symbols then go at the end.
- **Reorder**: drag a tile by its header. Or focus the ⋮⋮ handle (with Tab) and press ← / →.
- **Remove**: hover a tile and click ×.
- **Inside a chart**: drag to pan and pinch to zoom that one chart. Double-click to reset it to the slider's width.
  The mouse wheel scrolls the page, not the chart.
- The dot next to the exchange shows the session: green when the market is open, amber for pre-market or after hours, grey when it's closed.
  A "15 min delay" tag means TradingView is sending delayed data for that symbol.

Your symbol list, their order, the sort setting, the candle interval and the candle width are saved in your browser.

## Real-time data (optional)

Without a login, TradingView sends delayed data for many exchanges and keeps intraday history short.
To use your own TradingView account's data permissions:

1. Copy `.env.example` to `.env`.
2. Sign in at tradingview.com. In the browser dev tools, go to Application → Cookies and copy the `sessionid` and `sessionid_sign` values into `.env`.
3. Restart with `npm start`.

Keep `.env` private. Anyone with those cookies can use your TradingView session.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port for the local server |
| `HOST` | `127.0.0.1` | Only your own machine can reach the server. Set it to `0.0.0.0` to open the board from other devices on your network. |
| `TV_SESSION`, `TV_SIGNATURE` | (empty) | TradingView cookies for real-time data |

## How it's built

```
server.js            Express + WebSocket server. Shares one upstream stream per symbol/interval across tabs, keeps it
                     warm for 60 s after the last tab leaves, and reconnects on its own. Serves fonts and the chart library
lib/tv-source.js     TradingView-API v4: searchMarkets, watchCandles, and one shared quote session, all on one connection
lib/demo-source.js   Simulated data for `npm run demo`
public/index.html    Page layout
public/styles.css    Dark theme
public/app.js        Search, grid, charts, drag-to-reorder, live updates. Charts are only built for tiles near the screen
public/timeframes.js Candle intervals, used by both the server and the browser
```

TradingView-API is an unofficial community library and is not affiliated with TradingView.
It's fine for personal use; check TradingView's terms before doing anything more with it.
