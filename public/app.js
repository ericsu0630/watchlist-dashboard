import { TIMEFRAMES, DEFAULT_TIMEFRAME } from './timeframes.js';

const LWC = window.LightweightCharts;
const $ = (sel, root = document) => root.querySelector(sel);

// Chart colors come from the theme settings at the top of styles.css, so the stylesheet is the one place to change them.
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const COLORS = {
  up: css('--up'), down: css('--down'), text: css('--muted'), grid: css('--chart-grid'),
  cross: css('--crosshair'), label: css('--active'), lastPrice: css('--accent'),
};
// Translucent versions for volume bars and the price tick flash (6-digit hex + alpha).
Object.assign(COLORS, { volUp: `${COLORS.up}2e`, volDown: `${COLORS.down}2e`, flashUp: `${COLORS.up}33`, flashDown: `${COLORS.down}33` });
const CHART_FONT = "'Barlow Semi Condensed', system-ui, sans-serif";
const SESSION_LABELS = { market: 'Market open', pre_market: 'Pre-market', post_market: 'After hours', out_of_session: 'Market closed' };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const DEFAULTS = ['NASDAQ:AAPL', 'NASDAQ:NVDA', 'NASDAQ:MSFT', 'TWSE:2330', 'AMEX:SPY', 'NASDAQ:QQQ', 'BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'];
const SUGGESTIONS = ['NASDAQ:AAPL', 'NASDAQ:NVDA', 'NASDAQ:TSLA', 'AMEX:SPY', 'TWSE:2330', 'BINANCE:BTCUSDT', 'FX:EURUSD', 'TVC:GOLD'];

// ------------------------------------------------------------ State
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};
const SYMBOL_RE = /^[\w.!&\-]+:[\w.!&\-]+$/;
const state = {
  tf: store.get('pd.tf', DEFAULT_TIMEFRAME),
};
if (!TIMEFRAMES.some((t) => t.id === state.tf)) state.tf = DEFAULT_TIMEFRAME;

// Candle width (Lightweight Charts "bar spacing": px from one candle's centre to the next), shared by every chart.
// The slider steps in whole pixels; ZOOM_MIN/ZOOM_MAX must match the input's min/max in index.html.
const ZOOM_MIN = 1, ZOOM_MAX = 15, ZOOM_DEFAULT = 5;
const clampZoom = (px) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(Number(px) || ZOOM_DEFAULT)));
state.zoom = clampZoom(store.get('pd.zoomPx', ZOOM_DEFAULT));

// Sort order: 'asc' / 'desc' by ticker, 'gain' / 'loss' by day change %, or 'none' once the user arranges
// tiles themselves. Each tab has its own.
const SORT_MODES = ['asc', 'desc', 'gain', 'loss', 'none'];

// Tabs group the symbols: [{ id, name, symbols, sort }]. A symbol is in at most one tab.
// Boards from before tabs existed (pd.symbols, pd.sort) become a single "Default" tab.
const TAB_NAME_MAX = 40;
const newTabId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
function loadTabs() {
  let raw = store.get('pd.tabs', null);
  if (!Array.isArray(raw) || !raw.length) {
    raw = [{ id: 'default', name: 'Default', symbols: store.get('pd.symbols', null) ?? DEFAULTS.slice(), sort: store.get('pd.sort', 'none') }];
  }
  const seenSymbols = new Set(), seenIds = new Set();
  const tabs = raw.filter((t) => t && typeof t === 'object').map((t) => {
    let id = typeof t.id === 'string' && t.id ? t.id : newTabId();
    if (seenIds.has(id)) id = newTabId();
    seenIds.add(id);
    return {
      id,
      name: (typeof t.name === 'string' && t.name.trim() ? t.name.trim() : 'Untitled').slice(0, TAB_NAME_MAX),
      // Keep the first copy of any symbol that somehow appears twice.
      symbols: (Array.isArray(t.symbols) ? t.symbols : []).filter((s) => typeof s === 'string' && SYMBOL_RE.test(s) && !seenSymbols.has(s) && seenSymbols.add(s)),
      sort: SORT_MODES.includes(t.sort) ? t.sort : 'none',
    };
  });
  return tabs.length ? tabs : [{ id: 'default', name: 'Default', symbols: [], sort: 'none' }];
}
state.tabs = loadTabs();
state.activeTab = store.get('pd.activeTab', null);
if (!state.tabs.some((t) => t.id === state.activeTab)) state.activeTab = state.tabs[0].id;

const activeTab = () => state.tabs.find((t) => t.id === state.activeTab);
const tabById = (id) => state.tabs.find((t) => t.id === id);
const tabOf = (sym) => state.tabs.find((t) => t.symbols.includes(sym));
const allSymbols = () => state.tabs.flatMap((t) => t.symbols);
// The grid, sorting, reordering and live data all work on the open tab, through these two.
Object.defineProperty(state, 'symbols', { get: () => activeTab().symbols, set: (v) => { activeTab().symbols = v; } });
Object.defineProperty(state, 'sort', { get: () => activeTab().sort, set: (v) => { activeTab().sort = v; } });

const save = () => {
  store.set('pd.tabs', state.tabs); store.set('pd.activeTab', state.activeTab);
  store.set('pd.tf', state.tf); store.set('pd.zoomPx', state.zoom);
  store.set('pd.symbols', allSymbols()); // flat list, still readable by older versions of the page
};
save();

const tiles = new Map(); // symbol -> Tile
// Charts exist only for tiles on screen or within 300 px of it.
const visibility = new IntersectionObserver((entries) => {
  for (const e of entries) e.isIntersecting ? e.target.tile.mount() : e.target.tile.unmount();
}, { rootMargin: '300px 0px' });
const grid = $('#grid');
const tpl = $('#tile-tpl');

// ------------------------------------------------------------ Helpers
// Lightweight Charts renders timestamps as UTC; shift them so axis labels read in local time.
const toLocal = (t) => t - new Date(t * 1000).getTimezoneOffset() * 60;
const tfPreset = () => TIMEFRAMES.find((t) => t.id === state.tf);
const isIntraday = () => /^\d+$/.test(tfPreset().interval);
const splitSymbol = (id) => { const i = id.indexOf(':'); return [id.slice(0, i), id.slice(i + 1)]; };
const ticker = (sym) => splitSymbol(sym)[1];

function decimalsFor(pricescale, price) {
  if (pricescale > 0) return Math.max(0, Math.round(Math.log10(pricescale)));
  if (price == null) return 2;
  return Math.abs(price) < 1 ? 4 : 2;
}
function fmt(n, d) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
// DOM writes only when the value actually changes (quotes arrive every second).
function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
function setAttr(el, name, value) { if (el.getAttribute(name) !== value) el.setAttribute(name, value); }
const toCandle = (b) => ({ time: toLocal(b.time), open: b.open, high: b.high, low: b.low, close: b.close });
const toVolume = (b) => ({ time: toLocal(b.time), value: b.volume, color: b.close >= b.open ? COLORS.volUp : COLORS.volDown });

// Live prices (Taiwan listings, from Yahoo股市) are folded into the current candle on daily-and-up charts.
// TradingView stamps those candles 09:00 Taipei on the first trading day of the period, so periods are
// matched on the Taipei calendar: days, Monday-start weeks, months and quarters.
const TPE = 8 * 3600;
const LIVE_INTERVALS = new Set(['D', 'W', 'M', '3M']);
function periodIndex(t, interval) {
  const day = Math.floor((t + TPE) / 86400);
  if (interval === 'D') return day;
  if (interval === 'W') return Math.floor((day + 3) / 7); // 1 Jan 1970 was a Thursday
  const d = new Date(day * 86400_000);
  const months = d.getUTCFullYear() * 12 + d.getUTCMonth();
  return interval === 'M' ? months : Math.floor(months / 3);
}

// ------------------------------------------------------------ Tile
class Tile {
  constructor(symbol) {
    this.symbol = symbol;
    this.el = tpl.content.firstElementChild.cloneNode(true);
    this.el.dataset.symbol = symbol;
    this.decimals = null;
    this.lastTime = null;
    this.lastPrice = null;
    this.info = null;
    this.quote = {};
    // Candle data lives here; the chart is only a view of it while the tile is on screen.
    this.candleData = [];
    this.volumeData = [];
    this.live = null; // live quote with today's open/high/low, when the price comes from a live source
    this.provisional = false; // true while the last candle is a stand-in built from the live quote
    this.chart = null;
    this.view = null; // { pos, spacing } saved when the chart is taken down, so it comes back where it was
    // Look up the tile's elements once.
    const q = (sel) => $(sel, this.el);
    this.ui = {
      ticker: q('.ticker'), exch: q('.exch'), name: q('.name'), price: q('.price'), change: q('.change'),
      session: q('.session'), delay: q('.delay'), state: q('.state span'), chart: q('.chart'), grip: q('.grip'), remove: q('.remove'),
    };

    const [exch, ticker] = splitSymbol(symbol);
    this.ui.ticker.textContent = ticker;
    this.ui.exch.textContent = exch;
    this.ui.remove.setAttribute('aria-label', `Remove ${ticker}`);
    this.ui.grip.setAttribute('aria-label', `Reorder ${ticker}. Use left and right arrow keys.`);
    this.el.setAttribute('aria-label', `${ticker} on ${exch}`);

    this.ui.remove.addEventListener('click', () => removeSymbol(symbol));
    this.ui.chart.addEventListener('dblclick', () => this.fitRange());
    this.ui.grip.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); moveSymbol(symbol, -1); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); moveSymbol(symbol, 1); }
    });
    setupDrag(this);
    this.setLoading();
    this.el.tile = this;
    visibility.observe(this.el);
  }

  // Build the chart (called when the tile comes near the viewport).
  mount() {
    if (this.chart) return;
    this.chart = LWC.createChart(this.ui.chart, {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: COLORS.text,
        fontFamily: CHART_FONT,
        fontSize: 12,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderVisible: false, rightOffset: 2, barSpacing: state.zoom, minBarSpacing: 0.5, timeVisible: isIntraday(), secondsVisible: false, fixLeftEdge: false },
      crosshair: {
        mode: LWC.CrosshairMode.Normal,
        vertLine: { color: COLORS.cross, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: COLORS.label },
        horzLine: { color: COLORS.cross, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: COLORS.label },
      },
      // Leave the mouse wheel to the page so the grid scrolls; drag and pinch still pan/zoom.
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
    });
    this.candles = this.chart.addSeries(LWC.CandlestickSeries, {
      upColor: COLORS.up, downColor: COLORS.down, borderVisible: false,
      wickUpColor: COLORS.up, wickDownColor: COLORS.down,
      priceLineColor: COLORS.lastPrice, priceLineStyle: LWC.LineStyle.Dotted,
    });
    this.volume = this.chart.addSeries(LWC.HistogramSeries, {
      priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false,
    });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });
    if (this.decimals != null) this.applyPriceFormat();
    if (this.candleData.length) {
      this.candles.setData(this.candleData);
      this.volume.setData(this.volumeData);
      if (this.view) {
        this.chart.timeScale().applyOptions({ barSpacing: this.view.spacing });
        this.chart.timeScale().scrollToPosition(this.view.pos, false);
      } else this.fitRange();
    }
  }

  // Free the chart's canvases while the tile is far off screen; remember where it was scrolled to.
  unmount() {
    if (!this.chart) return;
    const ts = this.chart.timeScale();
    this.view = { pos: ts.scrollPosition(), spacing: ts.options().barSpacing };
    this.chart.remove();
    this.chart = this.candles = this.volume = null;
  }

  setLoading() {
    this.el.classList.remove('ready', 'error');
    this.el.classList.add('loading');
    this.ui.state.textContent = 'Loading chart';
    this.lastTime = null;
  }
  setError(message) {
    this.el.classList.remove('ready', 'loading', 'switching');
    this.el.classList.add('error');
    this.ui.state.textContent = message;
    this.provisional = false;
    this.candleData = [];
    this.volumeData = [];
    this.candles?.setData([]);
    this.volume?.setData([]);
  }

  // Keep the current candles on screen (dimmed) until the new interval's data arrives.
  applyTimeframe() {
    this.lastTime = null; // ignore stray updates until the new full snapshot lands
    if (this.el.classList.contains('ready')) this.el.classList.add('switching');
    else this.setLoading();
  }

  setBars(bars, full) {
    if (full) this.provisional = false; // replaced along with everything else
    else this.dropProvisional();
    if (full) {
      // A fresh snapshot of the same interval (e.g. after a reconnect) keeps the user's pan position;
      // a new interval, first load or recovery from an error starts at the latest candle.
      const refresh = this.el.classList.contains('ready') && !this.el.classList.contains('switching');
      this.candleData = bars.map(toCandle);
      this.volumeData = bars.map(toVolume);
      this.lastTime = bars.at(-1)?.time ?? null;
      this.el.classList.remove('loading', 'error', 'switching');
      this.el.classList.add('ready');
      if (!refresh) this.view = null;
      if (this.chart) {
        const ts = this.chart.timeScale();
        const pos = refresh ? ts.scrollPosition() : null;
        this.chart.applyOptions({ timeScale: { timeVisible: isIntraday() } });
        this.candles.setData(this.candleData);
        this.volume.setData(this.volumeData);
        if (refresh) ts.scrollToPosition(pos, false);
        else this.fitRange();
      }
    } else if (this.lastTime != null) {
      for (const b of bars) {
        if (b.time < this.lastTime) continue;
        const c = toCandle(b), v = toVolume(b);
        if (this.candleData.at(-1)?.time === c.time) {
          this.candleData[this.candleData.length - 1] = c;
          this.volumeData[this.volumeData.length - 1] = v;
        } else {
          this.candleData.push(c);
          this.volumeData.push(v);
        }
        this.candles?.update(c);
        this.volume?.update(v);
        this.lastTime = b.time;
      }
      // Keep memory bounded on a tile left open for days.
      if (this.candleData.length > 1500) {
        this.candleData = this.candleData.slice(-1000);
        this.volumeData = this.volumeData.slice(-1000);
      }
    }
    const last = bars.at(-1);
    if (last && this.quote.lp == null) this.renderPrice(last.close);
    if (this.decimals == null && last) { this.decimals = decimalsFor(0, last.close); this.applyPriceFormat(); }
    this.applyLive();
  }

  // Draws the live price into the current candle. TradingView's own (delayed) update of that candle
  // replaces it on its next tick, and this runs again right after, so the two never fight.
  applyLive() {
    const L = this.live;
    const interval = tfPreset().interval;
    if (!L || !L.time || this.lastTime == null || !this.candleData.length || !LIVE_INTERVALS.has(interval)) return;
    if (this.el.classList.contains('switching')) return; // data still belongs to the previous interval
    const now = periodIndex(L.time, interval);
    const lastPeriod = periodIndex(this.lastTime, interval);
    if (now === lastPeriod && !this.provisional) {
      const prev = this.candleData.at(-1);
      const c = {
        time: prev.time, open: prev.open, close: L.lp,
        high: Math.max(prev.high, L.lp, L.high ?? -Infinity),
        low: Math.min(prev.low, L.lp, L.low ?? Infinity),
      };
      const v = { time: prev.time, value: this.volumeData.at(-1).value, color: c.close >= c.open ? COLORS.volUp : COLORS.volDown };
      this.setLastBar(c, v, false);
    } else if (now > lastPeriod && L.open != null && L.high != null && L.low != null) {
      // The market has opened in a new period but TradingView's delayed feed hasn't drawn its first
      // candle yet (the first 15 minutes): stand in with today's numbers, volume unknown until then.
      const time = Math.floor((L.time + TPE) / 86400) * 86400 - TPE + 9 * 3600; // 09:00 Taipei today, like TradingView
      if ((L.time + TPE) % 86400 < 9 * 3600) return; // pre-open trial matching, not a trade
      const c = { time: toLocal(time), open: L.open, high: Math.max(L.high, L.lp), low: Math.min(L.low, L.lp), close: L.lp };
      const v = { time: c.time, value: 0, color: c.close >= c.open ? COLORS.volUp : COLORS.volDown };
      this.setLastBar(c, v, !this.provisional);
      this.provisional = true;
    }
  }

  setLastBar(c, v, append) {
    if (append) { this.candleData.push(c); this.volumeData.push(v); }
    else { this.candleData[this.candleData.length - 1] = c; this.volumeData[this.volumeData.length - 1] = v; }
    this.candles?.update(c);
    this.volume?.update(v);
  }

  dropProvisional() {
    if (!this.provisional) return;
    this.provisional = false;
    this.candleData.pop();
    this.volumeData.pop();
    this.candles?.pop(1);
    this.volume?.pop(1);
  }

  // Apply the shared candle width and bring the latest candle back to the right edge.
  fitRange() {
    this.view = null;
    if (!this.chart) return;
    const ts = this.chart.timeScale();
    ts.applyOptions({ barSpacing: state.zoom });
    ts.scrollToPosition(2, false);
  }

  setInfo(info) {
    this.info = info;
    if (info.description) setText(this.ui.name, info.description);
    if (info.pricescale) { this.decimals = decimalsFor(info.pricescale); this.applyPriceFormat(); }
  }

  applyPriceFormat() {
    if (!this.candles) return;
    const ps = this.info?.pricescale || 10 ** this.decimals;
    this.candles.applyOptions({ priceFormat: { type: 'price', precision: this.decimals, minMove: (this.info?.minmov || 1) / ps } });
  }

  setQuote(q) {
    Object.assign(this.quote, Object.fromEntries(Object.entries(q).filter(([, v]) => v != null)));
    this.quote.price_source = q.price_source ?? null; // cleared when Yahoo goes quiet and TradingView takes over
    const quote = this.quote;
    setAttr(this.ui.price, 'title', quote.price_source ? `Live price from ${quote.price_source}` : '');
    if (quote.description && !this.info?.description) setText(this.ui.name, quote.description);
    if (this.decimals == null && (quote.pricescale || quote.lp != null)) this.decimals = decimalsFor(quote.pricescale, quote.lp);

    if (quote.lp != null) this.renderPrice(quote.lp);

    // Live source: keep the current candle in step with the price above it.
    this.live = quote.price_source && quote.lp != null
      ? { lp: quote.lp, time: quote.lp_time, open: q.day_open ?? null, high: q.day_high ?? null, low: q.day_low ?? null }
      : null;
    if (this.live) this.applyLive();
    else this.dropProvisional(); // back on TradingView's delayed data

    const { change, session, delay } = this.ui;
    if (quote.ch != null && quote.chp != null) {
      const sign = quote.ch > 0 ? '+' : quote.ch < 0 ? '−' : '';
      const pct = `${sign}${fmt(Math.abs(quote.chp), 2)}`;
      setText(change, `${sign}${fmt(Math.abs(quote.ch), this.decimals ?? 2)}  ${pct}%`);
      setAttr(change, 'class', `change ${quote.ch > 0 ? 'up' : quote.ch < 0 ? 'down' : ''}`);
      setAttr(change, 'aria-label', `Day change ${pct} percent`);
    }

    const s = quote.current_session;
    if (s) {
      session.hidden = false;
      setAttr(session, 'class', `session ${s === 'market' ? 'open' : (s === 'pre_market' || s === 'post_market') ? 'ext' : ''}`);
      setAttr(session, 'title', SESSION_LABELS[s] || s);
    }

    const m = /^delayed[^\d]*(\d+)/.exec(quote.update_mode || '');
    delay.hidden = !m;
    if (m) setText(delay, `${Math.round(Number(m[1]) / 60)} min delay`);
  }

  renderPrice(price) {
    const el = this.ui.price;
    setText(el, fmt(price, this.decimals ?? decimalsFor(0, price)));
    // Brief tint on each tick. Web Animations restart cleanly without forcing a layout.
    if (this.lastPrice != null && price !== this.lastPrice && !reducedMotion.matches) {
      el.animate([{ backgroundColor: price > this.lastPrice ? COLORS.flashUp : COLORS.flashDown }, { backgroundColor: 'transparent' }],
        { duration: 700, easing: 'ease-out' });
    }
    this.lastPrice = price;
  }

  destroy() {
    visibility.unobserve(this.el);
    this.chart?.remove();
    this.el.remove();
  }
}

// ------------------------------------------------------------ Board
function render() {
  // Tiles exist for symbols in any tab; only the open tab's are in the grid. The others keep their
  // candles in memory (their charts are freed once they leave the page), so switching back is quick.
  const all = new Set(allSymbols());
  for (const [sym, tile] of tiles) if (!all.has(sym)) { tile.destroy(); tiles.delete(sym); }
  const shown = state.symbols;
  for (const el of [...grid.children]) if (!shown.includes(el.dataset.symbol)) el.remove();
  shown.forEach((sym, i) => {
    let tile = tiles.get(sym);
    if (!tile) { tile = new Tile(sym); tiles.set(sym, tile); }
    if (grid.children[i] !== tile.el) grid.insertBefore(tile.el, grid.children[i] || null);
  });
  const total = all.size;
  $('#empty').hidden = shown.length > 0 || news.open;
  if (!shown.length) {
    const named = state.tabs.length > 1 || activeTab().name !== 'Default';
    $('#empty-title').textContent = total && named ? `Nothing in “${activeTab().name}” yet` : 'Nothing on your board yet';
    $('#empty-text').textContent = total
      ? 'Search above to add a symbol to this tab, or right-click a tile in another tab and move it here. Or pick one to begin:'
      : 'Search for a stock, ETF, index, currency pair or crypto pair above to start tracking it. Or pick one to begin:';
  }
  $('#count').textContent = total ? `${total} symbol${total === 1 ? '' : 's'}` : '';
  renderTabs();
}

// A symbol can only be in one tab. If it's already in one, that tab opens and the tile is pointed out;
// otherwise it joins the open tab.
function addSymbol(sym) {
  const home = tabOf(sym);
  if (home && home !== activeTab()) switchTab(home.id, { scroll: false });
  if (!home) {
    state.symbols.push(sym); // at the end when unsorted…
    applySort(); // …or in its sorted place
    save();
    render();
    sendWatch();
    if (!news.open) warmNews();
    if (LIVE_SORTS.has(state.sort)) resortSoon(); // its place depends on a price that's on its way
  }
  // In the news view, stay there and include the new symbol's headlines.
  if (news.open) { if (!home) loadNews(); return; }
  const tile = tiles.get(sym);
  tile.el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  tile.el.classList.remove('flash'); void tile.el.offsetWidth; tile.el.classList.add('flash');
  if (home) announce(`${ticker(sym)} is already in ${home.name}`);
}
function removeSymbol(sym) {
  const tab = tabOf(sym);
  if (!tab) return;
  tab.symbols = tab.symbols.filter((s) => s !== sym);
  save();
  render();
  sendWatch();
}
function moveSymbol(sym, delta) {
  const i = state.symbols.indexOf(sym);
  const j = Math.max(0, Math.min(state.symbols.length - 1, i + delta));
  if (i === j) return;
  state.symbols.splice(i, 1);
  state.symbols.splice(j, 0, sym);
  setSort('none');
  save();
  render();
  tiles.get(sym).ui.grip.focus();
}
// Moves a symbol into another tab, in that tab's sorted place (or at its end when it's unsorted).
function moveToTab(sym, tabId, { hadFocus = null } = {}) {
  const from = tabOf(sym), to = tabById(tabId);
  if (!from || !to || from === to) return;
  const wasShown = from === activeTab();
  const next = wasShown ? state.symbols[state.symbols.indexOf(sym) + 1] ?? state.symbols[state.symbols.indexOf(sym) - 1] : null;
  // Was the tile focused (before any menu took focus)?
  hadFocus = wasShown && (hadFocus ?? tiles.get(sym)?.el.contains(document.activeElement));
  from.symbols = from.symbols.filter((s) => s !== sym);
  to.symbols.push(sym);
  applySort(to);
  save();
  render();
  sendWatch();
  flashTab(to.id);
  announce(`Moved ${ticker(sym)} to ${to.name}`);
  // Keyboard users keep their place: the neighbouring tile, or the tab itself when this tab is now empty.
  if (hadFocus) (next ? tiles.get(next).ui.grip : tabButton(state.activeTab))?.focus();
}

// ------------------------------------------------------------ Sort
const tickerCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function compareSymbols(a, b) {
  const [ea, ta] = splitSymbol(a), [eb, tb] = splitSymbol(b);
  return tickerCollator.compare(ta, tb) || tickerCollator.compare(ea, eb);
}
// Day change % of a symbol, from its tile's latest quote; null until a price has arrived.
function dayChange(sym) {
  const chp = tiles.get(sym)?.quote.chp;
  return Number.isFinite(chp) ? chp : null;
}
const LIVE_SORTS = new Set(['gain', 'loss']); // orders that change as prices move
function comparator(mode) {
  if (mode === 'asc') return compareSymbols;
  if (mode === 'desc') return (a, b) => compareSymbols(b, a);
  // Day change: gainers or losers first; symbols without a price yet go last, in ticker order.
  const dir = mode === 'gain' ? -1 : 1;
  return (a, b) => {
    const ca = dayChange(a), cb = dayChange(b);
    if (ca == null || cb == null) return (ca == null) - (cb == null) || compareSymbols(a, b);
    return dir * (ca - cb) || compareSymbols(a, b);
  };
}
function applySort(tab = activeTab()) {
  if (tab.sort === 'none') return;
  tab.symbols.sort(comparator(tab.sort));
}

// Reorders tiles with a short slide from where each one was, instead of a jump.
function withSlide(change) {
  const before = reducedMotion.matches ? null : new Map([...grid.children].map((el) => [el, el.getBoundingClientRect()]));
  change();
  if (!before) return;
  for (const el of grid.children) {
    const a = before.get(el);
    if (!a) continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2, .7, .2, 1)' });
  }
}

// Day-change sorts are kept current as prices move, but gently: a couple of seconds after prices
// arrive, then at most once a minute, and never while the pointer is over the grid, a menu is open
// or a tile is being dragged (so nothing moves out from under a click). Waiting re-sorts run as soon
// as the pointer leaves the grid.
const RESORT_MS = 60_000;
let pointerOnGrid = false, resortWaiting = false, resortTimer = null;
function resortLive() {
  if (!LIVE_SORTS.has(state.sort) || news.open || document.hidden) return;
  if (pointerOnGrid || dragSym || !menu.hidden || renaming) { resortWaiting = true; return; }
  resortWaiting = false;
  const next = [...state.symbols].sort(comparator(state.sort));
  if (next.join() === state.symbols.join()) return;
  withSlide(() => { state.symbols = next; save(); render(); });
}
function resortSoon(ms = 2000) {
  clearTimeout(resortTimer);
  resortTimer = setTimeout(resortLive, ms);
}
setInterval(resortLive, RESORT_MS);
grid.addEventListener('pointerenter', () => { pointerOnGrid = true; });
grid.addEventListener('pointerleave', () => { pointerOnGrid = false; if (resortWaiting) resortSoon(600); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && LIVE_SORTS.has(state.sort)) resortSoon(1500); });

const sortBtn = $('#sort');
const SORT_UI = {
  asc: { label: 'A–Z', item: 'Ticker A–Z', desc: 'ticker, A to Z' },
  desc: { label: 'Z–A', item: 'Ticker Z–A', desc: 'ticker, Z to A' },
  gain: { label: 'Gainers', item: 'Day change: gainers first', desc: 'day change, gainers first' },
  loss: { label: 'Losers', item: 'Day change: losers first', desc: 'day change, losers first' },
  none: { label: 'Unsorted', desc: 'your own order' },
};
function setSort(mode) {
  state.sort = mode;
  sortBtn.dataset.sort = mode;
  $('span', sortBtn).textContent = SORT_UI[mode].label;
  const text = `Sort: ${SORT_UI[mode].desc}. Choose how to order this tab.`;
  sortBtn.setAttribute('aria-label', text);
  sortBtn.title = text;
}
sortBtn.addEventListener('click', () => {
  if (!menu.hidden && menu.dataset.for === 'sort') { closeMenu(); return; }
  openMenu({}, sortBtn, 'Sort this tab', [
    { heading: 'Sort this tab by' },
    ...['asc', 'desc', 'gain', 'loss'].map((mode) => ({
      label: SORT_UI[mode].item,
      checked: state.sort === mode,
      hint: LIVE_SORTS.has(mode) ? 'Live' : null,
      action: () => {
        setSort(mode);
        withSlide(() => { applySort(); save(); render(); });
        if (LIVE_SORTS.has(mode)) resortSoon(); // pick up prices that arrive in the next moments
      },
    })),
  ], 'sort');
});
setSort(state.sort);
// A day-change order can't be worked out before prices arrive, so the saved order stands until they do.
if (LIVE_SORTS.has(state.sort)) resortSoon(3000);
else applySort();

// ------------------------------------------------------------ Tabs
const tabList = $('#tab-list');
const tabButton = (id) => tabList.querySelector(`[data-tab="${CSS.escape(id)}"]`);
let renaming = null; // id of the tab whose name is being edited

function renderTabs() {
  if (renaming) return; // don't replace the name field while it's being typed in
  const focusedTab = tabList.contains(document.activeElement) ? document.activeElement.dataset.tab : null;
  tabList.replaceChildren(...state.tabs.map((t) => {
    const b = document.createElement('button');
    const on = t.id === state.activeTab;
    b.type = 'button';
    b.role = 'tab';
    b.id = `tab-${t.id}`;
    b.className = 'tab';
    b.dataset.tab = t.id;
    b.tabIndex = on ? 0 : -1;
    b.setAttribute('aria-selected', String(on));
    b.setAttribute('aria-controls', 'grid');
    b.title = 'Double-click to rename. Right-click for more.';
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = t.name;
    const count = document.createElement('span');
    count.className = 'tab-count';
    count.textContent = t.symbols.length;
    count.setAttribute('aria-label', `${t.symbols.length} symbol${t.symbols.length === 1 ? '' : 's'}`);
    b.append(name, count);
    return b;
  }));
  grid.setAttribute('aria-labelledby', `tab-${state.activeTab}`);
  if (focusedTab) tabButton(focusedTab)?.focus();
}

function switchTab(id, { scroll = true } = {}) {
  if (id === state.activeTab || !tabById(id)) return;
  state.activeTab = id;
  setSort(state.sort); // the sort button shows this tab's setting
  save();
  render();
  sendWatch();
  if (scroll && !news.open) scrollTo(0, 0);
  if (LIVE_SORTS.has(state.sort)) resortSoon(); // once this tab's prices have caught up
}

function uniqueTabName(base) {
  const names = new Set(state.tabs.map((t) => t.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}
function createTab({ open = true } = {}) {
  const tab = { id: newTabId(), name: uniqueTabName('New tab'), symbols: [], sort: 'none' };
  state.tabs.push(tab);
  save();
  if (open) switchTab(tab.id);
  else render();
  return tab;
}

// Edits a tab's name in place: Enter or leaving the field keeps it, Esc cancels.
function startRename(id) {
  const tab = tabById(id);
  const b = tabButton(id);
  if (!tab || !b || renaming) return;
  renaming = id;
  const input = document.createElement('input');
  input.className = 'tab-rename';
  input.value = tab.name;
  input.maxLength = TAB_NAME_MAX;
  input.setAttribute('aria-label', 'Tab name');
  input.size = Math.max(6, tab.name.length + 1);
  b.querySelector('.tab-name').replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const name = input.value.trim().slice(0, TAB_NAME_MAX);
    if (keep && name && name !== tab.name) { tab.name = name; save(); }
    renaming = null;
    render(); // also refreshes the empty-tab message, which names the tab
    tabButton(id)?.focus();
  };
  input.addEventListener('input', () => { input.size = Math.max(6, input.value.length + 1); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep typing out of the tab list's arrow keys and the page's "/" shortcut
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

// Any tab can go except the last one left. A tab with symbols asks first, since its symbols go with it.
async function deleteTab(id) {
  const tab = tabById(id);
  if (!tab || state.tabs.length === 1) return;
  if (tab.symbols.length) {
    const list = tab.symbols.map(ticker);
    const shown = list.length > 6 ? `${list.slice(0, 6).join(', ')} and ${list.length - 6} more` : list.join(', ');
    const ok = await confirmDialog({
      title: `Delete “${tab.name}”?`,
      body: `Its ${list.length} symbol${list.length === 1 ? '' : 's'} (${shown}) will be removed from your board. To keep any, move them to another tab first.`,
      ok: 'Delete tab',
    });
    if (!ok) { tabButton(id)?.focus(); return; }
  }
  const i = state.tabs.indexOf(tab);
  state.tabs.splice(i, 1);
  if (state.activeTab === id) {
    state.activeTab = state.tabs[Math.max(0, i - 1)].id;
    setSort(state.sort);
  }
  save();
  render();
  sendWatch();
  announce(`Deleted ${tab.name}`);
  tabButton(state.activeTab)?.focus();
}

function flashTab(id) {
  const b = tabButton(id);
  if (!b) return;
  b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
}
const announcer = $('#announce');
function announce(text) { announcer.textContent = ''; requestAnimationFrame(() => { announcer.textContent = text; }); }

tabList.addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (b) switchTab(b.dataset.tab);
});
tabList.addEventListener('dblclick', (e) => {
  const b = e.target.closest('.tab');
  if (b) startRename(b.dataset.tab);
});
tabList.addEventListener('keydown', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  const i = state.tabs.findIndex((t) => t.id === b.dataset.tab);
  let j = null;
  if (e.key === 'ArrowRight') j = (i + 1) % state.tabs.length;
  else if (e.key === 'ArrowLeft') j = (i - 1 + state.tabs.length) % state.tabs.length;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = state.tabs.length - 1;
  else if (e.key === 'F2') { e.preventDefault(); startRename(b.dataset.tab); return; }
  else if (e.key === 'Delete') { e.preventDefault(); deleteTab(b.dataset.tab); return; }
  if (j == null) return;
  e.preventDefault();
  switchTab(state.tabs[j].id);
  tabButton(state.tabs[j].id)?.focus();
});
tabList.addEventListener('contextmenu', (e) => {
  const b = e.target.closest('.tab');
  if (!b || renaming) return;
  e.preventDefault();
  const id = b.dataset.tab;
  const last = state.tabs.length === 1;
  openMenu(e, b, `${tabById(id).name} tab`, [
    { label: 'Rename', hint: 'F2', action: () => startRename(id) },
    { label: 'Delete tab', danger: true, disabled: last, hint: last ? 'Last tab' : null, action: () => deleteTab(id) },
  ]);
});
$('#tab-add').addEventListener('click', () => {
  const tab = createTab();
  startRename(tab.id);
});

// Drop a dragged tile on a tab to move it there.
tabList.addEventListener('dragover', (e) => {
  const b = e.target.closest('.tab');
  if (!b || !dragSym || b.dataset.tab === tabOf(dragSym)?.id) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  for (const t of tabList.querySelectorAll('.drop-target')) if (t !== b) t.classList.remove('drop-target');
  b.classList.add('drop-target');
});
tabList.addEventListener('dragleave', (e) => {
  const b = e.target.closest('.tab');
  if (b && !b.contains(e.relatedTarget)) b.classList.remove('drop-target');
});
tabList.addEventListener('drop', (e) => {
  const b = e.target.closest('.tab');
  if (!b || !dragSym) return;
  e.preventDefault();
  b.classList.remove('drop-target');
  moveToTab(dragSym, b.dataset.tab);
});

// Right-click a tile (or press the context-menu key / Shift+F10 on it): move it to another tab, or remove it.
grid.addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.tile');
  if (!el) return;
  e.preventDefault();
  const sym = el.dataset.symbol;
  const hadFocus = el.contains(document.activeElement);
  const others = state.tabs.filter((t) => t.id !== state.activeTab);
  openMenu(e, $('.tile-head', el), `${ticker(sym)} actions`, [
    { heading: `Move ${ticker(sym)} to` },
    ...others.map((t) => ({ label: t.name, hint: String(t.symbols.length), action: () => moveToTab(sym, t.id, { hadFocus }) })),
    { label: 'New tab…', action: () => { const t = createTab({ open: false }); moveToTab(sym, t.id); startRename(t.id); } },
    { separator: true },
    { label: `Remove ${ticker(sym)}`, danger: true, action: () => removeSymbol(sym) },
  ]);
});

// ------------------------------------------------------------ Menu and confirmation
// One menu element, filled for whatever was right-clicked. Arrow keys, Home/End, Enter and Esc work as usual.
const menu = $('#menu');
let menuReturnFocus = null;
let menuToggle = null; // a button that opened the menu and closes it again when clicked
// `toggle` names a menu that belongs to a button (like Sort); clicking that button again closes it.
function openMenu(e, anchor, label, items, toggle = null) {
  menu.replaceChildren();
  menu.setAttribute('aria-label', label);
  menu.dataset.for = toggle || '';
  menuToggle = toggle ? anchor : null;
  menuToggle?.setAttribute('aria-expanded', 'true');
  for (const item of items) {
    if (item.separator) { const hr = document.createElement('div'); hr.className = 'menu-sep'; hr.role = 'separator'; menu.append(hr); continue; }
    if (item.heading) { const h = document.createElement('div'); h.className = 'menu-heading'; h.role = 'presentation'; h.textContent = item.heading; menu.append(h); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    b.role = item.checked != null ? 'menuitemradio' : 'menuitem';
    if (item.checked != null) b.setAttribute('aria-checked', String(item.checked));
    b.tabIndex = -1;
    b.className = `menu-item${item.danger ? ' danger' : ''}${item.checked != null ? ' radio' : ''}`;
    if (item.disabled) b.setAttribute('aria-disabled', 'true');
    const l = document.createElement('span'); l.textContent = item.label; b.append(l);
    if (item.hint) { const h = document.createElement('span'); h.className = 'menu-hint'; h.textContent = item.hint; b.append(h); }
    b.addEventListener('click', () => {
      if (item.disabled) return;
      const back = menuReturnFocus;
      closeMenu(false);
      item.action();
      // Unless the action moved focus somewhere useful, go back to where the menu was opened from.
      if (back?.isConnected && (!document.activeElement || document.activeElement === document.body || menu.contains(document.activeElement))) back.focus();
    });
    menu.append(b);
  }
  menuReturnFocus = document.activeElement;
  menu.hidden = false;
  // At the pointer; from the keyboard (no pointer position), under the item it belongs to.
  const fromKeyboard = e.button !== 2 && !e.clientX && !e.clientY;
  const r = anchor.getBoundingClientRect();
  let x = fromKeyboard ? r.left + 8 : e.clientX, y = fromKeyboard ? r.bottom + 4 : e.clientY;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  y = y + h > innerHeight - 8 ? Math.max(8, y - h) : y;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const usable = menuItems().filter((b) => !b.hasAttribute('aria-disabled'));
  (usable.find((b) => b.getAttribute('aria-checked') === 'true') || usable[0])?.focus();
}
const menuItems = () => [...menu.querySelectorAll('.menu-item')];
function closeMenu(restoreFocus = true) {
  if (menu.hidden) return;
  menu.hidden = true;
  menuToggle?.setAttribute('aria-expanded', 'false');
  menuToggle = null;
  if (restoreFocus && menuReturnFocus?.isConnected) menuReturnFocus.focus();
  menuReturnFocus = null;
}
menu.addEventListener('keydown', (e) => {
  const items = menuItems().filter((b) => !b.hasAttribute('aria-disabled'));
  const i = items.indexOf(document.activeElement);
  let j = null;
  if (e.key === 'ArrowDown') j = (i + 1) % items.length;
  else if (e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = items.length - 1;
  else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(); return; }
  if (j == null) return;
  e.preventDefault();
  items[j]?.focus();
});
document.addEventListener('pointerdown', (e) => {
  if (!menu.hidden && !menu.contains(e.target) && !menuToggle?.contains(e.target)) closeMenu(false);
}, true);
addEventListener('blur', () => closeMenu(false));
addEventListener('resize', () => closeMenu(false));
addEventListener('scroll', () => closeMenu(false), { passive: true });

const confirmEl = $('#confirm');
function confirmDialog({ title, body, ok }) {
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  $('#confirm-ok').textContent = ok;
  confirmEl.returnValue = '';
  confirmEl.showModal();
  $('#confirm button[value="cancel"]').focus(); // the safe choice, so a stray Enter doesn't delete
  return new Promise((resolve) => confirmEl.addEventListener('close', () => resolve(confirmEl.returnValue === 'ok'), { once: true }));
}

// ------------------------------------------------------------ Drag to reorder
let dragSym = null;
function setupDrag(tile) {
  const el = tile.el;
  const head = $('.tile-head', el);
  // Only the header starts a drag, so panning inside the chart still works.
  head.addEventListener('pointerdown', (e) => { if (!e.target.closest('.remove')) el.draggable = true; });
  el.addEventListener('pointerup', () => { el.draggable = false; });
  el.addEventListener('dragstart', (e) => {
    dragSym = tile.symbol;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tile.symbol);
    requestAnimationFrame(() => el.classList.add('dragging'));
  });
  el.addEventListener('dragend', () => {
    el.draggable = false;
    el.classList.remove('dragging');
    clearDropMarks();
    dragSym = null;
  });
  el.addEventListener('dragover', (e) => {
    if (!dragSym || dragSym === tile.symbol) return;
    e.preventDefault();
    const after = isAfter(e, el);
    clearDropMarks();
    el.classList.add(after ? 'drop-after' : 'drop-before');
  });
  el.addEventListener('drop', (e) => {
    if (!dragSym || dragSym === tile.symbol) return;
    e.preventDefault();
    const after = isAfter(e, el);
    const before = state.symbols.join();
    const from = state.symbols.indexOf(dragSym);
    state.symbols.splice(from, 1);
    let to = state.symbols.indexOf(tile.symbol) + (after ? 1 : 0);
    state.symbols.splice(to, 0, dragSym);
    if (state.symbols.join() !== before) setSort('none'); // the user's own arrangement
    save();
    clearDropMarks();
    render();
  });
}
const isAfter = (e, el) => { const r = el.getBoundingClientRect(); return e.clientX > r.left + r.width / 2; };
const clearDropMarks = () => document.querySelectorAll('.drop-before, .drop-after, .drop-target').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-target'));

// ------------------------------------------------------------ Timeframe
const tfEl = $('#tf');
for (const t of TIMEFRAMES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.role = 'radio';
  b.textContent = t.label;
  b.title = t.hint;
  b.dataset.tf = t.id;
  b.addEventListener('click', () => setTimeframe(t.id));
  tfEl.append(b);
}
tfEl.addEventListener('keydown', (e) => {
  const i = TIMEFRAMES.findIndex((t) => t.id === state.tf);
  const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!d) return;
  e.preventDefault();
  const next = TIMEFRAMES[(i + d + TIMEFRAMES.length) % TIMEFRAMES.length];
  setTimeframe(next.id);
  tfEl.querySelector(`[data-tf="${next.id}"]`).focus();
});
function syncTfButtons() {
  for (const b of tfEl.children) {
    const on = b.dataset.tf === state.tf;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}
function setTimeframe(id) {
  if (id === state.tf) return;
  state.tf = id;
  save();
  syncTfButtons();
  for (const tile of tiles.values()) tile.applyTimeframe();
  sendWatch();
}
syncTfButtons();

// ------------------------------------------------------------ Candle width slider
const zoomInput = $('#zoom-input');
const zoomValue = $('#zoom-value');
function showZoom() {
  zoomValue.textContent = `${state.zoom}px`;
  zoomInput.setAttribute('aria-valuetext', `${state.zoom} pixel${state.zoom === 1 ? '' : 's'} per candle`);
}
zoomInput.value = state.zoom;
showZoom();
zoomInput.addEventListener('input', () => {
  state.zoom = clampZoom(zoomInput.value);
  showZoom();
  for (const tile of tiles.values()) tile.fitRange();
});
zoomInput.addEventListener('change', save);
zoomInput.addEventListener('dblclick', () => {
  zoomInput.value = ZOOM_DEFAULT;
  zoomInput.dispatchEvent(new Event('input'));
  save();
});

// ------------------------------------------------------------ Live connection
let ws = null;
let wsRetry = 0;
const conn = $('#conn');
function setConn(cls, text) { conn.className = `conn ${cls}`; $('span', conn).textContent = text; }

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.addEventListener('open', () => { wsRetry = 0; setConn('', 'Connecting'); sendWatch(); });
  ws.addEventListener('message', (e) => handle(JSON.parse(e.data)));
  ws.addEventListener('close', () => {
    setConn('down', 'Reconnecting');
    setTimeout(connect, Math.min(15000, 600 * 2 ** wsRetry++));
  });
}
function sendWatch() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'watch', symbols: state.symbols, tf: state.tf }));
}
function handle(msg) {
  const tile = tiles.get(msg.symbol);
  switch (msg.type) {
    case 'hello':
      $('#demo-note').hidden = !msg.demo;
      break;
    case 'bars':
      if (!conn.classList.contains('live')) setConn('live', 'Live');
      if (tile && msg.tf === state.tf) tile.setBars(msg.bars, msg.full);
      break;
    case 'info':
      tile?.setInfo(msg.info);
      break;
    case 'quote':
      tile?.setQuote(msg.quote);
      break;
    case 'error':
      if (tile && (!msg.tf || msg.tf === state.tf)) tile.setError(msg.message);
      break;
    case 'retrying':
      setConn('down', 'TradingView unreachable');
      if (tile && msg.tf === state.tf && !tile.el.classList.contains('ready')) tile.ui.state.textContent = msg.message;
      break;
  }
}

// ------------------------------------------------------------ Search
const input = $('#search-input');
const list = $('#search-results');
let results = [];
let active = -1;
let searchSeq = 0;
let debounce;

input.addEventListener('input', () => {
  clearTimeout(debounce);
  const q = input.value.trim();
  if (!q) return closeResults();
  debounce = setTimeout(() => runSearch(q), 160);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const pick = results[active] || results[0];
    const typed = input.value.trim().toUpperCase();
    if (pick) choose(pick.id);
    else if (SYMBOL_RE.test(typed)) choose(typed); // Exact EXCHANGE:SYMBOL
  } else if (e.key === 'Escape') { input.value = ''; closeResults(); input.blur(); }
});
input.addEventListener('blur', () => setTimeout(closeResults, 120));
input.addEventListener('focus', () => { if (input.value.trim() && results.length) openResults(); });
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input && !e.metaKey && !e.ctrlKey) { e.preventDefault(); input.focus(); input.select(); }
});

async function runSearch(q) {
  const seq = ++searchSeq;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (seq !== searchSeq) return;
    if (!res.ok) throw new Error(data.error);
    results = data;
    active = results.length ? 0 : -1;
    drawResults(q);
  } catch (err) {
    if (seq !== searchSeq) return;
    results = [];
    list.innerHTML = `<li class="r-note">${escapeHtml(err.message || 'Search is unavailable right now.')}</li>`;
    openResults();
  }
}
function drawResults(q) {
  if (!results.length) {
    list.innerHTML = `<li class="r-note">No symbols match “${escapeHtml(q)}”. Try the company name, or type EXCHANGE:SYMBOL and press Enter.</li>`;
  } else {
    list.innerHTML = results.map((r, i) => `
      <li role="option" id="opt-${i}" data-i="${i}" aria-selected="${i === active}"${tabOf(r.id) ? ' class="added"' : ''}>
        <span class="r-sym">${escapeHtml(r.symbol)}</span>
        <span class="r-desc">${escapeHtml(stripTags(r.description || ''))}</span>
        <span class="r-tag"><b>${escapeHtml(r.exchange || '')}</b> ${escapeHtml(r.type || '')}${tabOf(r.id) ? `<span class="r-in">In ${escapeHtml(tabOf(r.id).name)}</span>` : ''}</span>
      </li>`).join('');
  }
  openResults();
}
list.addEventListener('pointerdown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  e.preventDefault();
  choose(results[Number(li.dataset.i)].id);
});
function move(d) {
  if (!results.length) return;
  active = (active + d + results.length) % results.length;
  for (const li of list.querySelectorAll('li[data-i]')) li.setAttribute('aria-selected', String(Number(li.dataset.i) === active));
  input.setAttribute('aria-activedescendant', `opt-${active}`);
  list.querySelector(`#opt-${active}`)?.scrollIntoView({ block: 'nearest' });
}
function choose(id) {
  input.value = '';
  closeResults();
  addSymbol(id);
}
function openResults() { list.hidden = false; input.setAttribute('aria-expanded', 'true'); }
function closeResults() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stripTags = (s) => s.replace(/<[^>]*>/g, '');

// ------------------------------------------------------------ Empty-state chips
const chips = $('#chips');
for (const id of SUGGESTIONS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = splitSymbol(id)[1];
  b.title = id;
  b.addEventListener('click', () => addSymbol(id));
  chips.append(b);
}

// ------------------------------------------------------------ News view
// Replaces the grid with the latest headlines (window set by the server, 24 hours) for every symbol on the board.
const NEWS_REFRESH_MS = 5 * 60_000;
const news = {
  open: false, data: null, filter: null, seq: 0, loading: false, timer: null, tick: null,
  view: $('#news'), list: $('#news-list'), sub: $('#news-sub'), note: $('#news-note'), filterEl: $('#news-filter'), tabsEl: $('#news-tabs'),
  tabFilter: null, // tab id chosen with the tab buttons, or null for all tabs
  btn: $('#news-btn'), back: $('#news-back'), refresh: $('#news-refresh'),
};

function openNews({ push = true } = {}) {
  if (news.open) return;
  news.open = true;
  grid.hidden = true; // hidden tiles count as off screen, so their charts are freed while reading
  $('#tabs').hidden = true; // headlines cover every tab
  $('#empty').hidden = true;
  news.view.hidden = false;
  news.btn.setAttribute('aria-expanded', 'true');
  if (push) history.pushState({ view: 'news' }, '', '#news');
  scrollTo(0, 0);
  news.back.focus();
  loadNews();
  news.timer = setInterval(() => loadNews({ fresh: true, background: true }), NEWS_REFRESH_MS);
  news.tick = setInterval(tickNews, 60_000); // keep "x min ago" current
}
function closeNews({ fromHistory = false } = {}) {
  if (!news.open) return;
  if (!fromHistory && history.state?.view === 'news') { history.back(); return; } // popstate closes it
  news.open = false;
  clearInterval(news.timer); clearInterval(news.tick);
  news.view.hidden = true;
  grid.hidden = false;
  $('#tabs').hidden = false;
  news.btn.setAttribute('aria-expanded', 'false');
  if (location.hash === '#news') history.replaceState(null, '', location.pathname);
  render();
  if (LIVE_SORTS.has(state.sort)) resortSoon(800);
  news.btn.focus();
}
news.btn.addEventListener('click', () => (news.open ? closeNews() : openNews()));
news.back.addEventListener('click', () => closeNews());
news.refresh.addEventListener('click', () => loadNews({ fresh: true }));
addEventListener('popstate', () => (location.hash === '#news' ? openNews({ push: false }) : closeNews({ fromHistory: true })));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && news.open && document.activeElement !== input) closeNews();
});

// Opening the view takes what the server already has (instant, possibly a few minutes old) and then,
// if the server says newer headlines are on the way, asks again and waits for them (`fresh`).
// The 5-minute refresh and the refresh button always wait for fresh headlines.
async function loadNews({ fresh = false, background = false } = {}) {
  const seq = ++news.seq;
  const symbols = allSymbols(); // every tab
  if (!symbols.length) { news.data = { items: [], failed: [] }; renderNews(); return; }
  news.loading = true;
  news.refresh.classList.add('spinning');
  // Dim the list only when the user asked for new headlines; a background update leaves it readable.
  news.list.classList.toggle('refreshing', !!news.data && !background);
  if (!news.data) news.list.innerHTML = '<div class="news-state"><p>Loading headlines…</p></div>';
  let again = false;
  try {
    const res = await fetch(`/api/news?symbols=${encodeURIComponent(symbols.join(','))}${fresh ? '&fresh=1' : ''}`);
    const data = await res.json();
    if (seq !== news.seq) return;
    if (!res.ok) throw new Error(data.error || 'Headlines are unavailable right now.');
    news.data = data;
    again = data.refreshing && !fresh;
  } catch (err) {
    if (seq !== news.seq) return;
    // A failed background update keeps the headlines already on screen.
    if (!(background && news.data && !news.data.error)) news.data = { error: err.message || 'Headlines are unavailable right now.' };
  } finally {
    if (seq === news.seq) {
      news.loading = false;
      news.refresh.classList.remove('spinning');
      news.list.classList.remove('refreshing');
      renderNews();
    }
  }
  if (again && seq === news.seq && news.open) loadNews({ fresh: true, background: true });
}

// Ask the server to start fetching headlines before the News view is opened, so it opens instantly.
let lastWarm = { key: '', at: 0 };
function warmNews() {
  const key = allSymbols().join(',');
  if (!key || (key === lastWarm.key && Date.now() - lastWarm.at < 60_000)) return;
  lastWarm = { key, at: Date.now() };
  fetch(`/api/news/warm?symbols=${encodeURIComponent(key)}`, { method: 'POST' }).catch(() => {});
}
setTimeout(warmNews, 3000); // after the charts have had their turn
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') warmNews(); });
news.btn.addEventListener('pointerenter', warmNews);

function timeAgo(t) {
  const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60));
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}
function dayLabel(t) {
  const d = new Date(t * 1000), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
const clock = (t) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

// Updates the "x min ago" labels in place, so focus and hover aren't disturbed.
// After midnight "Today" and "Yesterday" headings are out of date, so the list is rebuilt then.
function tickNews() {
  if (!news.open) return;
  if (new Date().toDateString() !== news.renderedDay) { renderNews(); return; }
  for (const el of news.list.querySelectorAll('.ago')) setText(el, timeAgo(Number(el.dataset.t)));
}

// Identifies a focusable element in the news view across a rebuild of its HTML.
function newsFocusKey(el) {
  const part = el.dataset.tabfilter != null ? `t:${el.dataset.tabfilter}`
    : el.dataset.filter != null ? `f:${el.dataset.filter}`
    : el.classList.contains('story-title') ? 't'
    : el.hasAttribute('data-retry') ? 'r' : null;
  return part && `${el.closest('.story')?.dataset.id ?? ''}|${part}`;
}

function renderNews() {
  if (!news.open) return;
  // Rebuilding replaces the elements: remember what had keyboard focus and put it back afterwards.
  const focused = news.view.contains(document.activeElement) ? newsFocusKey(document.activeElement) : null;
  drawNews();
  news.renderedDay = new Date().toDateString();
  if (focused) {
    for (const el of news.view.querySelectorAll('[data-tabfilter], [data-filter], .story-title, [data-retry]')) {
      if (newsFocusKey(el) === focused) { el.focus({ preventScroll: true }); break; }
    }
  }
}

function drawNews() {
  const d = news.data;
  const symbols = allSymbols(); // headlines cover every tab
  const n = symbols.length;
  if (!d) return;
  if (d.error) {
    news.sub.textContent = '';
    news.filterEl.replaceChildren();
    news.tabsEl.hidden = true;
    news.note.hidden = true;
    news.list.innerHTML = `<div class="news-state"><p>${escapeHtml(d.error)} Check your internet connection.</p><button type="button" data-retry>Try again</button></div>`;
    return;
  }
  const items = d.items || [];
  // Filters for a tab or symbol that's no longer on the board are dropped.
  if (news.tabFilter && !tabById(news.tabFilter)) news.tabFilter = null;
  if (news.filter && !symbols.includes(news.filter)) news.filter = null;
  // A tab shows the stories that mention any of its symbols; a symbol, the stories that mention it.
  const tabSet = (t) => new Set(t.symbols);
  const inSet = (set) => (it) => it.symbols.some((s) => set.has(s));
  const tabFilter = news.tabFilter ? tabById(news.tabFilter) : null;
  const shown = news.filter ? items.filter((it) => it.symbols.includes(news.filter))
    : tabFilter ? items.filter(inSet(tabSet(tabFilter))) : items;

  const win = `${d.windowHours || 24} hours`;
  const updated = d.refreshing ? ' Checking for newer headlines…' : d.fetchedAt ? ` Updated ${clock(d.fetchedAt)}.` : '';
  const recentN = items.filter((it) => !it.older).length;
  const olderN = items.length - recentN;
  const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  news.sub.textContent = n
    ? `${plural(recentN, 'headline')} from the last ${win} for your ${plural(n, 'symbol')}${olderN ? `, plus ${olderN} earlier for quiet ones` : ''}.${updated}`
    : '';

  // Tab buttons (All, then each tab with its headline count), shown when there's more than one tab.
  const tabBtn = (id, label, count) =>
    `<button type="button" data-tabfilter="${escapeHtml(id)}" aria-pressed="${(news.tabFilter || '') === id}">${escapeHtml(label)} <span>${count}</span></button>`;
  news.tabsEl.hidden = state.tabs.length < 2 || !n;
  news.tabsEl.innerHTML = news.tabsEl.hidden ? ''
    : tabBtn('', 'All', items.length) + state.tabs.map((t) => tabBtn(t.id, t.name, items.filter(inSet(tabSet(t))).length)).join('');
  // Symbol chips: the chosen tab's symbols (or every symbol), with their headline counts, in board order.
  // Clicking one shows only its headlines; clicking it again goes back.
  const counts = new Map(symbols.map((s) => [s, 0]));
  for (const it of items) for (const s of it.symbols) counts.set(s, (counts.get(s) || 0) + 1);
  const chip = (sym) =>
    `<button type="button" data-filter="${escapeHtml(sym)}" aria-pressed="${news.filter === sym}">${escapeHtml(ticker(sym))} <span>${counts.get(sym) || 0}</span></button>`;
  news.filterEl.innerHTML = n ? (tabFilter ? tabFilter.symbols : symbols).map(chip).join('') : '';

  const failed = (d.failed || []).filter((s) => symbols.includes(s));
  news.note.hidden = !failed.length;
  if (failed.length) news.note.textContent = `Headlines for ${failed.map(ticker).join(', ')} couldn't be loaded. They'll be retried on the next refresh.`;

  if (!n) {
    news.list.innerHTML = '<div class="news-state"><p>Add a symbol with the search bar to see its headlines here.</p></div>';
    return;
  }
  if (!shown.length) {
    const msg = failed.length === n ? 'Headlines couldn\'t be loaded for any of your symbols.'
      : news.filter ? `No headlines for ${escapeHtml(ticker(news.filter))} in the last ${win}.`
      : tabFilter ? `No headlines for the symbols in ${escapeHtml(tabFilter.name)} in the last ${win}.` : `No headlines for your symbols in the last ${win}.`;
    news.list.innerHTML = `<div class="news-state"><p>${msg}</p>${failed.length === n ? '<button type="button" data-retry>Try again</button>' : ''}</div>`;
    return;
  }
  let html = '', lastDay = '', inOlder = false;
  for (const it of shown) {
    if (it.older && !inOlder) {
      // Quiet symbols: their latest stories from before the window, in their own section.
      inOlder = true; lastDay = '';
      const quiet = (d.olderFor || []).filter((s) => (news.filter ? s === news.filter : !tabFilter || tabFilter.symbols.includes(s))).map(ticker);
      html += `<section class="news-older"><h2>Earlier headlines</h2><p>No news in the last ${win} for ${escapeHtml(quiet.join(', ') || 'this symbol')}, so here are the latest stories from the past two weeks.</p></section>`;
    }
    const day = dayLabel(it.published);
    if (day !== lastDay) { html += `<h2 class="news-day">${escapeHtml(day)}</h2>`; lastDay = day; }
    const lang = it.lang ? ` lang="${escapeHtml(it.lang)}"` : '';
    const title = it.url
      ? `<a class="story-title" href="${escapeHtml(it.url)}" target="_blank" rel="noopener noreferrer"${lang}>${escapeHtml(it.title)}</a>`
      : `<span class="story-title"${lang}>${escapeHtml(it.title)}</span>`;
    const chips = it.symbols.map((s) => `<button type="button" data-filter="${escapeHtml(s)}" title="Show only ${escapeHtml(ticker(s))} headlines">${escapeHtml(ticker(s))}</button>`).join('');
    html += `<article class="story" data-id="${escapeHtml(it.id)}"><time datetime="${new Date(it.published * 1000).toISOString()}">${clock(it.published)}</time><div>${title}
      <div class="story-meta">${it.source ? `<span>${escapeHtml(it.source)}</span>` : ''}<span class="ago" data-t="${it.published}">${timeAgo(it.published)}</span>${chips}</div></div></article>`;
  }
  news.list.innerHTML = html;
}
// Filter chips (top row and on each story) and retry buttons.
news.view.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tabfilter]');
  if (t) {
    news.tabFilter = t.dataset.tabfilter || null;
    news.filter = null;
    renderNews();
    return;
  }
  const f = e.target.closest('[data-filter]');
  if (f) {
    const sym = f.dataset.filter;
    news.filter = news.filter === sym ? null : sym;
    // A symbol from outside the chosen tab (a story can mention several) widens the tab choice to All.
    if (news.filter && news.tabFilter && !tabById(news.tabFilter)?.symbols.includes(sym)) news.tabFilter = null;
    renderNews();
    return;
  }
  if (e.target.closest('[data-retry]')) loadNews();
});

// ------------------------------------------------------------ Go
if (new URLSearchParams(location.search).has('debug')) window.__watchlist = { tiles, state }; // for tests
render();
if (location.hash === '#news') openNews({ push: false });
connect();
// Charts draw text on canvas, which doesn't re-render when a web font arrives; nudge them once fonts are in.
document.fonts?.ready.then(() => { for (const t of tiles.values()) t.chart?.applyOptions({ layout: { fontFamily: CHART_FONT } }); });
