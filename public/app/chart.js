import { COLORS, CHART_FONT } from './theme.js';
import { state, isIntraday } from './state.js';

const LWC = window.LightweightCharts;

// Lightweight Charts renders timestamps as UTC; shift them so axis labels read in local time.
export const toLocal = (t) => t - new Date(t * 1000).getTimezoneOffset() * 60;
// The reverse of toLocal (exact except within the hour a daylight-saving change skips or repeats).
export const fromLocal = (t) => t + new Date(t * 1000).getTimezoneOffset() * 60;
const toCandle = (b) => ({ time: toLocal(b.time), open: b.open, high: b.high, low: b.low, close: b.close });
const toVolume = (b) => ({ time: toLocal(b.time), value: b.volume, color: b.close >= b.open ? COLORS.volUp : COLORS.volDown });

// Live prices (Taiwan listings, from Yahoo股市) are folded into the current candle on daily-and-up charts.
// TradingView stamps those candles 09:00 Taipei on the first trading day of the period, so periods are
// matched on the Taipei calendar: days, Monday-start weeks, months and quarters.
const TPE = 8 * 3600;
// On 1H and 4H the server already sends live candles for the session (built from Yahoo's minutes,
// polled once a minute); the live price keeps the newest one current in between. TradingView's intraday
// candles start at 09:00 Taipei: 1H on the hour, 4H at 09:00 and 13:00.
const LIVE_INTERVALS = new Set(['60', '240', 'D', 'W', 'M', '3M']);
const INTRADAY = new Set(['60', '240']);
export function periodIndex(t, interval) {
  const day = Math.floor((t + TPE) / 86400);
  if (interval === '60') return Math.floor((t + TPE - 9 * 3600) / 3600);
  if (interval === '240') return day * 2 + ((t + TPE) % 86400 >= 13 * 3600 ? 1 : 0);
  if (interval === 'D') return day;
  if (interval === 'W') return Math.floor((day + 3) / 7); // 1 Jan 1970 was a Thursday
  const d = new Date(day * 86400_000);
  const months = d.getUTCFullYear() * 12 + d.getUTCMonth();
  return interval === 'M' ? months : Math.floor(months / 3);
}

export class CandleSeries {
  candleData = [];
  volumeData = [];
  lastTime = null;
  provisional = false;
  chart = null;
  candles = null;
  volume = null;

  replaceData(candles = [], volume = [], lastTime = null, provisional = false) {
    this.candleData = candles;
    this.volumeData = volume;
    this.lastTime = lastTime;
    this.provisional = provisional;
    this.candles?.setData(candles);
    this.volume?.setData(volume);
  }

  setBars(bars, full) {
    if (full) {
      this.replaceData(bars.map(toCandle), bars.map(toVolume), bars.at(-1)?.time ?? null);
      return;
    }
    this.dropProvisional();
    if (this.lastTime == null) {
      return;
    }
    for (const b of bars) {
      if (b.time < this.lastTime) {
        continue;
      }
      const candle = toCandle(b);
      const volume = toVolume(b);
      this.setLastBar(candle, volume, this.candleData.at(-1)?.time !== candle.time);
      this.lastTime = b.time;
    }
    if (this.candleData.length > 1500) {
      this.candleData = this.candleData.slice(-1000);
      this.volumeData = this.volumeData.slice(-1000);
    }
  }

  // Keep the current candle in step with live Taiwan quotes between bar updates.
  applyLive(live, interval) {
    if (!live) {
      this.dropProvisional();
      return;
    }
    if (!live.time || this.lastTime == null || !this.candleData.length || !LIVE_INTERVALS.has(interval)) {
      return;
    }
    const now = periodIndex(live.time, interval);
    const lastPeriod = periodIndex(this.lastTime, interval);
    const intraday = INTRADAY.has(interval);
    if (now === lastPeriod && !this.provisional) {
      const prev = this.candleData.at(-1);
      const candle = {
        time: prev.time, open: prev.open, close: live.lp,
        high: Math.max(prev.high, live.lp, intraday ? -Infinity : live.high ?? -Infinity),
        low: Math.min(prev.low, live.lp, intraday ? Infinity : live.low ?? Infinity),
      };
      const volume = { time: prev.time, value: this.volumeData.at(-1).value, color: candle.close >= candle.open ? COLORS.volUp : COLORS.volDown };
      this.setLastBar(candle, volume, false);
    } else if (!intraday && now > lastPeriod && live.open != null && live.high != null && live.low != null) {
      // Draw a provisional candle until the delayed feed starts the new period.
      if ((live.time + TPE) % 86400 < 9 * 3600) {
        return;
      }
      const time = Math.floor((live.time + TPE) / 86400) * 86400 - TPE + 9 * 3600;
      const candle = { time: toLocal(time), open: live.open, high: Math.max(live.high, live.lp), low: Math.min(live.low, live.lp), close: live.lp };
      const volume = { time: candle.time, value: 0, color: candle.close >= candle.open ? COLORS.volUp : COLORS.volDown };
      this.setLastBar(candle, volume, !this.provisional);
      this.provisional = true;
    }
  }

  setLastBar(candle, volume, append) {
    if (append) {
      this.candleData.push(candle);
      this.volumeData.push(volume);
    } else {
      this.candleData[this.candleData.length - 1] = candle;
      this.volumeData[this.volumeData.length - 1] = volume;
    }
    this.candles?.update(candle);
    this.volume?.update(volume);
  }

  dropProvisional() {
    if (!this.provisional) {
      return;
    }
    this.provisional = false;
    this.candleData.pop();
    this.volumeData.pop();
    this.candles?.pop(1);
    this.volume?.pop(1);
  }
}

export function createChartView(host, interactive, tf) {
  const chart = LWC.createChart(host, {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: COLORS.text,
      fontFamily: CHART_FONT,
      fontSize: 12,
      attributionLogo: false,
      panes: { enableResize: interactive },
    },
    grid: { vertLines: { visible: false }, horzLines: { color: COLORS.grid } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
    timeScale: { borderVisible: false, rightOffset: 2, barSpacing: state.zoom, minBarSpacing: 0.5, timeVisible: isIntraday(tf), secondsVisible: false, fixLeftEdge: false },
    crosshair: {
      mode: LWC.CrosshairMode.Normal,
      vertLine: { color: COLORS.cross, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: COLORS.label },
      horzLine: { color: COLORS.cross, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: COLORS.label },
    },
    handleScroll: interactive,
    handleScale: interactive,
  });
  const candles = chart.addSeries(LWC.CandlestickSeries, {
    upColor: COLORS.up, downColor: COLORS.down, borderVisible: false,
    wickUpColor: COLORS.up, wickDownColor: COLORS.down,
    priceLineColor: COLORS.lastPrice, priceLineStyle: LWC.LineStyle.Dotted,
  });
  const volume = chart.addSeries(LWC.HistogramSeries, {
    priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false,
  });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });
  return { chart, candles, volume };
}

export function applyChartPriceFormat(series, tile) {
  if (!series || tile.decimals == null) {
    return;
  }
  const ps = tile.info?.pricescale || 10 ** tile.decimals;
  series.applyOptions({ priceFormat: { type: 'price', precision: tile.decimals, minMove: (tile.info?.minmov || 1) / ps } });
}
