import { $, setText, setAttr, splitSymbol } from './util.js';
import { state, tfPreset, isIntraday } from './state.js';
import { CandleSeries, createChartView, applyChartPriceFormat } from './chart.js';
import { createIndicatorRenderer } from './indicators.js';
import { createDividendLayer } from './dividend-layer.js';
import { setupIndicatorSettings } from './indicator-settings.js';
import { syncTfButtons } from './timeframe.js';
import { sendWatch } from './live.js';

export const chartViewer = {
  dialog: $('#chart-viewer'), host: $('#chart-viewer-chart'), title: $('#chart-viewer-title'), meta: $('#chart-viewer-meta'), close: $('#chart-viewer-close'),
  price: $('#chart-viewer-price'), change: $('#chart-viewer-change'),
  intervals: $('#chart-viewer-tf'), status: $('#chart-viewer-status'),
  tile: null, tf: null, series: null, returnFocus: null, dividendLayer: null,
};
let indicators;

export function updateChartViewerHeader(tile) {
  if (chartViewer.tile !== tile) {
    return;
  }
  const [exchange, symbol] = splitSymbol(tile.symbol);
  const description = tile.info?.description || tile.quote.description || tile.ui.name.textContent;
  setText(chartViewer.title, symbol);
  setText(chartViewer.meta, [exchange, description].filter(Boolean).join(' · '));
  setText(chartViewer.price, tile.ui.price.textContent);
  setText(chartViewer.change, tile.ui.change.textContent);
  setAttr(chartViewer.change, 'class', tile.ui.change.className);
  setAttr(chartViewer.change, 'aria-label', tile.ui.change.getAttribute('aria-label') ?? '');
  setAttr(chartViewer.close, 'aria-label', `Close ${symbol} enlarged chart`);
}

function resetChartViewerRange() {
  const ts = chartViewer.series.chart.timeScale();
  ts.applyOptions({ barSpacing: Math.max(state.zoom, 6) });
  ts.scrollToPosition(2, false);
}

function showChartViewerStatus(message) {
  setText(chartViewer.status, message);
  chartViewer.status.hidden = !message;
}

function seedChartViewer() {
  const { tile, series, tf } = chartViewer;
  if (tf === state.tf && tile.lastTime != null) {
    series.replaceData(tile.candleData.slice(), tile.volumeData.slice(), tile.lastTime, tile.provisional);
    showChartViewerStatus('');
    resetChartViewerRange();
    return;
  }
  series.replaceData();
  if (tf === state.tf && tile.el.classList.contains('error')) {
    showChartViewerStatus(tile.ui.state.textContent);
  } else if (tf === state.tf && tile.el.classList.contains('ready') && !tile.el.classList.contains('switching')) {
    showChartViewerStatus('No price history for this timeframe.');
  } else {
    showChartViewerStatus('Loading chart…');
  }
}

export function openChartViewer(tile) {
  if (!tile.candleData.length || chartViewer.dialog.open) {
    return;
  }
  chartViewer.tile = tile;
  chartViewer.tf = state.tf;
  chartViewer.returnFocus = tile.ui.chart;
  syncTfButtons(chartViewer.intervals, chartViewer.tf);
  updateChartViewerHeader(tile);
  chartViewer.dialog.showModal();
  chartViewer.series = Object.assign(new CandleSeries(), createChartView(chartViewer.host, true, chartViewer.tf));
  applyChartPriceFormat(chartViewer.series.candles, tile);
  const renderIndicators = createIndicatorRenderer(chartViewer.series);
  indicators.open(tile.symbol, (settings) => {
    renderIndicators(settings);
    tile.setGridIndicators(settings);
  });
  chartViewer.dividendLayer = createDividendLayer(chartViewer.series, { interval: () => tfPreset(chartViewer.tf).interval });
  chartViewer.dividendLayer.setEvents(tile.dividends);
  seedChartViewer();
  chartViewer.close.focus();
}

// New dividend data for a tile that's open in the enlarged chart.
export function updateChartViewerDividends(tile) {
  if (chartViewer.tile === tile && chartViewer.dividendLayer) {
    chartViewer.dividendLayer.setEvents(tile.dividends);
  }
}

export function setChartViewerTimeframe(id) {
  if (!chartViewer.dialog.open || id === chartViewer.tf) {
    return;
  }
  chartViewer.tf = id;
  syncTfButtons(chartViewer.intervals, id);
  const { chart } = chartViewer.series;
  chart.applyOptions({ timeScale: { timeVisible: isIntraday(id) } });
  chart.priceScale('right').applyOptions({ autoScale: true });
  seedChartViewer();
  sendWatch();
}

export function closeChartViewer(tile = null, restoreFocus = true) {
  if (tile && chartViewer.tile !== tile) {
    return;
  }
  if (!restoreFocus) {
    chartViewer.returnFocus = null;
  }
  if (chartViewer.dialog.open) {
    chartViewer.dialog.close();
  }
}

export function handleChartViewerMessage(msg) {
  const { tile, tf, series, dialog } = chartViewer;
  if (!dialog.open || msg.symbol !== tile?.symbol || msg.tf !== tf) {
    return;
  }
  if (msg.type === 'bars') {
    const ts = series.chart.timeScale();
    const pos = msg.full && series.lastTime != null ? ts.scrollPosition() : null;
    series.setBars(msg.bars, msg.full);
    if (msg.full) {
      showChartViewerStatus(series.lastTime == null ? 'No price history for this timeframe.' : '');
      if (pos != null) {
        ts.scrollToPosition(pos, false);
      } else if (series.lastTime != null) {
        resetChartViewerRange();
      }
    }
    series.applyLive(tile.live, tfPreset(tf).interval);
  } else if (msg.type === 'error') {
    series.replaceData();
    showChartViewerStatus(msg.message);
  } else if (msg.type === 'retrying' && series.lastTime == null) {
    showChartViewerStatus(msg.message);
  }
}

export function setupChartViewer() {
  indicators = setupIndicatorSettings(chartViewer.dialog);
  chartViewer.close.addEventListener('click', () => closeChartViewer());
  chartViewer.dialog.addEventListener('pointerdown', (e) => {
    if (e.target === chartViewer.dialog) {
      closeChartViewer();
    }
  });
  chartViewer.dialog.addEventListener('close', () => {
    const returnFocus = chartViewer.returnFocus;
    chartViewer.dividendLayer?.detach();
    chartViewer.series?.chart.remove();
    indicators.close();
    chartViewer.tile = chartViewer.tf = chartViewer.series = chartViewer.returnFocus = chartViewer.dividendLayer = null;
    sendWatch();
    if (returnFocus?.isConnected) {
      returnFocus.focus();
    }
  });
}
