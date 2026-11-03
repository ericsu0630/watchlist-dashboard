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
const state = {
  symbols: store.get('pd.symbols', null) ?? DEFAULTS.slice(),
  tf: store.get('pd.tf', DEFAULT_TIMEFRAME),
};
if (!TIMEFRAMES.some((t) => t.id === state.tf)) state.tf = DEFAULT_TIMEFRAME;

// Candle width (Lightweight Charts "bar spacing": px from one candle's centre to the next), shared by every chart.
// The slider steps in whole pixels; ZOOM_MIN/ZOOM_MAX must match the input's min/max in index.html.
const ZOOM_MIN = 1, ZOOM_MAX = 15, ZOOM_DEFAULT = 5;
const clampZoom = (px) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(Number(px) || ZOOM_DEFAULT)));
state.zoom = clampZoom(store.get('pd.zoomPx', ZOOM_DEFAULT));

// Sort order: 'asc' / 'desc' by ticker, or 'none' once the user arranges tiles themselves.
const SORT_MODES = ['asc', 'desc', 'none'];
state.sort = store.get('pd.sort', 'none');
if (!SORT_MODES.includes(state.sort)) state.sort = 'none';

const save = () => {
  store.set('pd.symbols', state.symbols); store.set('pd.tf', state.tf); store.set('pd.zoomPx', state.zoom); store.set('pd.sort', state.sort);
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
  // Create / remove tiles and put them in state order.
  for (const [sym, tile] of tiles) if (!state.symbols.includes(sym)) { tile.destroy(); tiles.delete(sym); }
  state.symbols.forEach((sym, i) => {
    let tile = tiles.get(sym);
    if (!tile) { tile = new Tile(sym); tiles.set(sym, tile); }
    if (grid.children[i] !== tile.el) grid.insertBefore(tile.el, grid.children[i] || null);
  });
  $('#empty').hidden = state.symbols.length > 0 || news.open;
  $('#count').textContent = state.symbols.length ? `${state.symbols.length} symbol${state.symbols.length === 1 ? '' : 's'}` : '';
}

function addSymbol(sym) {
  if (!state.symbols.includes(sym)) {
    state.symbols.push(sym); // at the end when unsorted…
    applySort(); // …or in its sorted place
    save();
    render();
    sendWatch();
    if (!news.open) warmNews();
  }
  // In the news view, stay there and include the new symbol's headlines.
  if (news.open) { loadNews(); return; }
  const tile = tiles.get(sym);
  tile.el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  tile.el.classList.remove('flash'); void tile.el.offsetWidth; tile.el.classList.add('flash');
}
function removeSymbol(sym) {
  state.symbols = state.symbols.filter((s) => s !== sym);
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

// ------------------------------------------------------------ Sort
const tickerCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function compareSymbols(a, b) {
  const [ea, ta] = splitSymbol(a), [eb, tb] = splitSymbol(b);
  return tickerCollator.compare(ta, tb) || tickerCollator.compare(ea, eb);
}
function applySort() {
  if (state.sort === 'none') return;
  const dir = state.sort === 'asc' ? 1 : -1;
  state.symbols.sort((a, b) => dir * compareSymbols(a, b));
}
const sortBtn = $('#sort');
const SORT_UI = {
  asc: { label: 'A–Z', aria: 'Sorted by ticker, A to Z. Activate to sort Z to A.' },
  desc: { label: 'Z–A', aria: 'Sorted by ticker, Z to A. Activate to sort A to Z.' },
  none: { label: 'Unsorted', aria: 'Unsorted: your own order. Activate to sort by ticker, A to Z.' },
};
function setSort(mode) {
  state.sort = mode;
  sortBtn.dataset.sort = mode;
  $('span', sortBtn).textContent = SORT_UI[mode].label;
  sortBtn.setAttribute('aria-label', SORT_UI[mode].aria);
  sortBtn.title = SORT_UI[mode].aria;
}
sortBtn.addEventListener('click', () => {
  setSort(state.sort === 'asc' ? 'desc' : 'asc');
  applySort();
  save();
  render();
});
setSort(state.sort);
applySort();

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
const clearDropMarks = () => grid.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));

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
    else if (/^[\w.!&\-]+:[\w.!&\-]+$/.test(typed)) choose(typed); // Exact EXCHANGE:SYMBOL
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
      <li role="option" id="opt-${i}" data-i="${i}" aria-selected="${i === active}" class="${state.symbols.includes(r.id) ? 'added' : ''}">
        <span class="r-sym">${escapeHtml(r.symbol)}</span>
        <span class="r-desc">${escapeHtml(stripTags(r.description || ''))}</span>
        <span class="r-tag"><b>${escapeHtml(r.exchange || '')}</b> ${escapeHtml(r.type || '')}</span>
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
  view: $('#news'), list: $('#news-list'), sub: $('#news-sub'), note: $('#news-note'), filterEl: $('#news-filter'),
  btn: $('#news-btn'), back: $('#news-back'), refresh: $('#news-refresh'),
};
const ticker = (sym) => splitSymbol(sym)[1];

function openNews({ push = true } = {}) {
  if (news.open) return;
  news.open = true;
  grid.hidden = true; // hidden tiles count as off screen, so their charts are freed while reading
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
  news.btn.setAttribute('aria-expanded', 'false');
  if (location.hash === '#news') history.replaceState(null, '', location.pathname);
  render();
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
  if (!state.symbols.length) { news.data = { items: [], failed: [] }; renderNews(); return; }
  news.loading = true;
  news.refresh.classList.add('spinning');
  // Dim the list only when the user asked for new headlines; a background update leaves it readable.
  news.list.classList.toggle('refreshing', !!news.data && !background);
  if (!news.data) news.list.innerHTML = '<div class="news-state"><p>Loading headlines…</p></div>';
  let again = false;
  try {
    const res = await fetch(`/api/news?symbols=${encodeURIComponent(state.symbols.join(','))}${fresh ? '&fresh=1' : ''}`);
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
  const key = state.symbols.join(',');
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
  const part = el.dataset.filter != null ? `f:${el.dataset.filter}`
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
    for (const el of news.view.querySelectorAll('[data-filter], .story-title, [data-retry]')) {
      if (newsFocusKey(el) === focused) { el.focus({ preventScroll: true }); break; }
    }
  }
}

function drawNews() {
  const d = news.data;
  const n = state.symbols.length;
  if (!d) return;
  if (d.error) {
    news.sub.textContent = '';
    news.filterEl.replaceChildren();
    news.note.hidden = true;
    news.list.innerHTML = `<div class="news-state"><p>${escapeHtml(d.error)} Check your internet connection.</p><button type="button" data-retry>Try again</button></div>`;
    return;
  }
  const items = d.items || [];
  // A filter for a symbol that's no longer on the board is dropped.
  if (news.filter && !state.symbols.includes(news.filter)) news.filter = null;
  const shown = news.filter ? items.filter((it) => it.symbols.includes(news.filter)) : items;

  const win = `${d.windowHours || 24} hours`;
  const updated = d.refreshing ? ' Checking for newer headlines…' : d.fetchedAt ? ` Updated ${clock(d.fetchedAt)}.` : '';
  const recentN = items.filter((it) => !it.older).length;
  const olderN = items.length - recentN;
  const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  news.sub.textContent = n
    ? `${plural(recentN, 'headline')} from the last ${win} for your ${plural(n, 'symbol')}${olderN ? `, plus ${olderN} earlier for quiet ones` : ''}.${updated}`
    : '';

  // Filter chips: All, then each symbol with its headline count, in board order.
  const counts = new Map(state.symbols.map((s) => [s, 0]));
  for (const it of items) for (const s of it.symbols) counts.set(s, (counts.get(s) || 0) + 1);
  const chip = (sym, label, count) =>
    `<button type="button" data-filter="${escapeHtml(sym)}" aria-pressed="${(news.filter || '') === sym}">${escapeHtml(label)} <span>${count}</span></button>`;
  news.filterEl.innerHTML = n ? chip('', 'All', items.length) + state.symbols.map((s) => chip(s, ticker(s), counts.get(s) || 0)).join('') : '';

  const failed = (d.failed || []).filter((s) => state.symbols.includes(s));
  news.note.hidden = !failed.length;
  if (failed.length) news.note.textContent = `Headlines for ${failed.map(ticker).join(', ')} couldn't be loaded. They'll be retried on the next refresh.`;

  if (!n) {
    news.list.innerHTML = '<div class="news-state"><p>Add a symbol with the search bar to see its headlines here.</p></div>';
    return;
  }
  if (!shown.length) {
    const msg = failed.length === n ? 'Headlines couldn\'t be loaded for any of your symbols.'
      : news.filter ? `No headlines for ${escapeHtml(ticker(news.filter))} in the last ${win}.` : `No headlines for your symbols in the last ${win}.`;
    news.list.innerHTML = `<div class="news-state"><p>${msg}</p>${failed.length === n ? '<button type="button" data-retry>Try again</button>' : ''}</div>`;
    return;
  }
  let html = '', lastDay = '', inOlder = false;
  for (const it of shown) {
    if (it.older && !inOlder) {
      // Quiet symbols: their latest stories from before the window, in their own section.
      inOlder = true; lastDay = '';
      const quiet = (d.olderFor || []).filter((s) => !news.filter || s === news.filter).map(ticker);
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
  const f = e.target.closest('[data-filter]');
  if (f) {
    const sym = f.dataset.filter || null;
    news.filter = news.filter === sym && f.closest('.story') ? null : sym;
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
