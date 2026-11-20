import { COLORS } from './theme.js';

const RSI_PERIOD = 14;

function movingAverage(candles, period, exponential) {
  if (candles.length < period) {
    return [];
  }
  let average = candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period;
  const alpha = 2 / (period + 1);
  const points = [{ time: candles[period - 1].time, value: average }];
  for (let i = period; i < candles.length; i++) {
    const { time, close } = candles[i];
    if (exponential) {
      average += (close - average) * alpha;
    } else {
      average += (close - candles[i - period].close) / period;
    }
    points.push({ time, value: average });
  }
  return points;
}

function relativeStrengthIndex(candles) {
  let gain = 0;
  let loss = 0;
  const points = [];
  for (let i = 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    // Seed from the first period, then apply Wilder's smoothing.
    const weight = i <= RSI_PERIOD ? 1 : (RSI_PERIOD - 1) / RSI_PERIOD;
    gain = gain * weight + Math.max(change, 0) / RSI_PERIOD;
    loss = loss * weight + Math.max(-change, 0) / RSI_PERIOD;
    if (i >= RSI_PERIOD) {
      const total = gain + loss;
      points.push({ time: candles[i].time, value: total === 0 ? 50 : (gain / total) * 100 });
    }
  }
  return points;
}

export function createIndicatorRenderer(view, { compact = false } = {}) {
  const { chart, candles, volume } = view;
  const { LineSeries, LineStyle } = window.LightweightCharts;
  let averages = [];
  const lines = [];
  let rsi = null;

  function refresh() {
    for (const [i, { type, period }] of averages.entries()) {
      lines[i].setData(movingAverage(view.candleData, period, type === 'ema'));
    }
    if (rsi) {
      rsi.setData(relativeStrengthIndex(view.candleData));
    }
  }
  candles.subscribeDataChanged(refresh);

  return (settings) => {
    if (volume.options().visible !== settings.volume) {
      volume.applyOptions({ visible: settings.volume });
      candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: settings.volume ? 0.24 : 0.08 } });
    }
    while (lines.length > settings.averages.length) {
      chart.removeSeries(lines.pop());
    }
    averages = settings.averages;
    for (const [i, { color }] of averages.entries()) {
      if (lines[i]) {
        lines[i].applyOptions({ color });
      } else {
        lines.push(chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false }));
      }
    }

    if (settings.rsi && !rsi) {
      rsi = chart.addSeries(LineSeries, {
        color: settings.rsiColor, lineWidth: 1, priceLineVisible: false,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      }, 1);
      candles.getPane().setStretchFactor(compact ? 2 : 3);
      rsi.getPane().setStretchFactor(1);
      for (const price of [30, 70]) {
        rsi.createPriceLine({ price, color: COLORS.cross, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: !compact });
      }
    } else if (!settings.rsi && rsi) {
      chart.removeSeries(rsi);
      rsi = null;
    } else if (rsi && rsi.options().color !== settings.rsiColor) {
      rsi.applyOptions({ color: settings.rsiColor });
    }
    refresh();
  };
}
