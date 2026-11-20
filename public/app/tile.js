import { $, setText, setAttr, splitSymbol, decimalsFor, fmt, reducedMotion } from './util.js';
import { COLORS } from './theme.js';
import { state, tfPreset, isIntraday } from './state.js';
import { CandleSeries, createChartView, applyChartPriceFormat } from './chart.js';
import { chartViewer, updateChartViewerHeader, openChartViewer, closeChartViewer } from './chart-viewer.js';
import { removeSymbol, moveSymbol } from './board.js';
import { setupDrag } from './drag.js';

const SESSION_LABELS = { market: 'Market open', pre_market: 'Pre-market', post_market: 'After hours', out_of_session: 'Market closed' };

// Charts exist only for tiles on screen or within 300 px of it.
const visibility = new IntersectionObserver((entries) => {
  for (const e of entries) e.isIntersecting ? e.target.tile.mount() : e.target.tile.unmount();
}, { rootMargin: '300px 0px' });
const tpl = $('#tile-tpl');

export class Tile extends CandleSeries {
  constructor(symbol) {
    super();
    this.symbol = symbol;
    this.el = tpl.content.firstElementChild.cloneNode(true);
    this.el.dataset.symbol = symbol;
    this.decimals = null;
    this.lastPrice = null;
    this.info = null;
    this.quote = {};
    this.live = null; // live quote with today's open/high/low, when the price comes from a live source
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
    this.ui.chart.setAttribute('aria-label', `Open an enlarged chart for ${ticker}`);
    this.ui.chart.addEventListener('click', () => openChartViewer(this));
    this.ui.chart.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') {
        return;
      }
      e.preventDefault();
      openChartViewer(this);
    });
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
    if (this.chart) {
      return;
    }
    const view = createChartView(this.ui.chart, false);
    this.chart = view.chart;
    this.candles = view.candles;
    this.volume = view.volume;
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
    this.replaceData();
  }

  // Keep the current candles on screen (dimmed) until the new interval's data arrives.
  applyTimeframe() {
    this.lastTime = null; // ignore stray updates until the new full snapshot lands
    if (this.el.classList.contains('ready')) this.el.classList.add('switching');
    else this.setLoading();
  }

  setBars(bars, full) {
    if (full) {
      // A fresh snapshot of the same interval (e.g. after a reconnect) keeps the user's pan position;
      // a new interval, first load or recovery from an error starts at the latest candle.
      const refresh = this.el.classList.contains('ready') && !this.el.classList.contains('switching');
      this.el.classList.remove('loading', 'error', 'switching');
      this.el.classList.add('ready');
      const ts = this.chart?.timeScale();
      const pos = refresh ? ts?.scrollPosition() : null;
      this.chart?.applyOptions({ timeScale: { timeVisible: isIntraday() } });
      super.setBars(bars, full);
      if (pos != null) {
        ts.scrollToPosition(pos, false);
      } else if (!refresh) {
        this.fitRange();
      }
    } else {
      super.setBars(bars, full);
    }
    const last = bars.at(-1);
    if (last && this.quote.lp == null) {
      this.renderPrice(last.close);
      updateChartViewerHeader(this);
    }
    if (this.decimals == null && last) { this.decimals = decimalsFor(0, last.close); this.applyPriceFormat(); }
    this.applyLive(this.live, tfPreset().interval);
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
    updateChartViewerHeader(this);
  }

  applyPriceFormat() {
    applyChartPriceFormat(this.candles, this);
    if (chartViewer.tile === this) {
      applyChartPriceFormat(chartViewer.series?.candles, this);
    }
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
    this.applyLive(this.live, tfPreset().interval);
    if (chartViewer.tile === this) {
      chartViewer.series?.applyLive(this.live, tfPreset(chartViewer.tf).interval);
    }

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

    // Data that isn't live gets a tag: "15 min delay", or "End of day" for feeds TradingView only
    // updates after the close (some indices without a login), which otherwise look live but sit on
    // the previous day's numbers all session.
    const m = /^delayed[^\d]*(\d+)/.exec(quote.update_mode || '');
    const eod = quote.update_mode === 'endofday';
    delay.hidden = !m && !eod;
    if (m) setText(delay, `${Math.round(Number(m[1]) / 60)} min delay`);
    else if (eod) setText(delay, 'End of day');
    setAttr(delay, 'title', eod ? 'TradingView only updates this symbol after the market closes' : m ? 'TradingView is sending delayed data for this symbol' : '');
    updateChartViewerHeader(this);
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
    closeChartViewer(this, false);
    visibility.unobserve(this.el);
    this.chart?.remove();
    this.el.remove();
  }
}
