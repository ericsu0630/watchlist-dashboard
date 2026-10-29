import { TIMEFRAMES, DEFAULT_TIMEFRAME } from './timeframes.js';

const LWC = window.LightweightCharts;
const $ = (sel, root = document) => root.querySelector(sel);

const COLORS = {
  up: '#34d3a0', down: '#ff6e7f', text: '#7d8aa3', grid: '#1b2638', cross: '#5b6a86', label: '#22304a', lastPrice: '#93a5ff',
  volUp: '#34d3a02e', volDown: '#ff6e7f2e', flashUp: '#34d3a033', flashDown: '#ff6e7f33',
};
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

const save = () => { store.set('pd.symbols', state.symbols); store.set('pd.tf', state.tf); store.set('pd.zoomPx', state.zoom); };
save();

const tiles = new Map(); // symbol -> Tile
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
  }

  mountChart() {
    if (this.chart) return;
    this.chart = LWC.createChart(this.ui.chart, {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: COLORS.text,
        fontFamily: "'Barlow Semi Condensed', system-ui, sans-serif",
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
  }

  setLoading() {
    this.el.classList.remove('ready', 'error');
    this.el.classList.add('loading');
    this.ui.state.textContent = 'Loading chart';
    this.lastTime = null;
  }
  setError(message) {
    this.el.classList.remove('ready', 'loading');
    this.el.classList.add('error');
    this.ui.state.textContent = message;
    this.candles?.setData([]);
    this.volume?.setData([]);
  }

  applyTimeframe() {
    this.chart?.applyOptions({ timeScale: { timeVisible: isIntraday() } });
    this.candles?.setData([]);
    this.volume?.setData([]);
    this.setLoading();
  }

  setBars(bars, full) {
    this.mountChart();
    if (full) {
      this.candles.setData(bars.map(toCandle));
      this.volume.setData(bars.map(toVolume));
      this.lastTime = bars.at(-1)?.time ?? null;
      this.el.classList.remove('loading', 'error');
      this.el.classList.add('ready');
      this.fitRange();
    } else if (this.lastTime != null) {
      for (const b of bars) {
        if (b.time < this.lastTime) continue;
        this.candles.update(toCandle(b));
        this.volume.update(toVolume(b));
        this.lastTime = b.time;
      }
    }
    const last = bars.at(-1);
    if (last && this.quote.lp == null) this.renderPrice(last.close);
    if (this.decimals == null && last) { this.decimals = decimalsFor(0, last.close); this.applyPriceFormat(); }
  }

  // Apply the shared candle width and bring the latest candle back to the right edge.
  fitRange() {
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
    const quote = this.quote;
    if (quote.description && !this.info?.description) setText(this.ui.name, quote.description);
    if (this.decimals == null && (quote.pricescale || quote.lp != null)) this.decimals = decimalsFor(quote.pricescale, quote.lp);

    if (quote.lp != null) this.renderPrice(quote.lp);

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
    tile.mountChart();
  });
  $('#empty').hidden = state.symbols.length > 0;
  $('#count').textContent = state.symbols.length ? `${state.symbols.length} symbol${state.symbols.length === 1 ? '' : 's'}` : '';
}

function addSymbol(sym) {
  if (!state.symbols.includes(sym)) {
    state.symbols.push(sym);
    save();
    render();
    sendWatch();
  }
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
  save();
  render();
  tiles.get(sym).ui.grip.focus();
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
    const from = state.symbols.indexOf(dragSym);
    state.symbols.splice(from, 1);
    let to = state.symbols.indexOf(tile.symbol) + (after ? 1 : 0);
    state.symbols.splice(to, 0, dragSym);
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

// ------------------------------------------------------------ Go
render();
connect();
