// Dividend badges on a chart: a "D" at the bottom of the price pane under each ex-dividend candle, and a
// dotted line at the selected one. Drawn by a series primitive on the candle series.
import { COLORS, CHART_FONT } from './theme.js';
import { toLocal, fromLocal, periodIndex } from './chart.js';

const TPE = 8 * 3600;
const INTRADAY = new Set(['60', '240']);
const ID_PREFIX = 'div:';

// Ex-dividend dates are Taipei calendar days; trading starts at 09:00.
const exDateTime = (exDate) => Date.parse(`${exDate}T09:00:00+08:00`) / 1000;
const taipeiDay = (t) => Math.floor((t + TPE) / 86400);

/**
 * Index of the candle an ex-date belongs to, or -1: the last candle starting at or before 09:00 Taipei on
 * the ex-date, as long as the ex-date is inside its period (on 1H/4H, the ex-date's first candle).
 */
export function candleIndexFor(candles, exDate, interval) {
  if (!candles.length) {
    return -1;
  }
  const exRaw = exDateTime(exDate);
  const exShifted = toLocal(exRaw);
  let lo = 0;
  let hi = candles.length - 1;
  if (candles[0].time > exShifted) {
    return -1;
  }
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid].time <= exShifted) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  let i = lo;
  if (INTRADAY.has(interval) && taipeiDay(fromLocal(candles[i].time)) !== taipeiDay(exRaw)) {
    // No candle at 09:00 that day: use the day's first one.
    i += 1;
    if (i >= candles.length || taipeiDay(fromLocal(candles[i].time)) !== taipeiDay(exRaw)) {
      return -1;
    }
    return i;
  }
  if (i === candles.length - 1 && periodIndex(fromLocal(candles[i].time), interval) !== periodIndex(exRaw, interval)) {
    return -1; // after the newest candle (an announced future ex-date)
  }
  return i;
}

/**
 * Attaches dividend badges to `view` (a Tile or the enlarged chart's CandleSeries: chart, candles, candleData).
 * `interval()` gives the chart's TradingView interval. Returns { setEvents, select, selected, clusterAt, marks, detach }.
 */
export function createDividendLayer(view, { compact = false, interval }) {
  const radius = compact ? 6 : 9;
  const fontSize = compact ? 8 : 11;
  let events = [];
  let groups = []; // [{ time, events }] per candle, oldest first
  let groupsKey = '';
  let clusters = []; // [{ key, x, events }] badges as drawn (close ones merged)
  let selectedExDate = null;
  let paneHeight = 0;
  let requestUpdate = () => {};

  function regroup() {
    const data = view.candleData;
    const key = `${interval()}|${data.length}|${data[0]?.time}|${data.at(-1)?.time}|${events.length}`;
    if (key === groupsKey) {
      return;
    }
    groupsKey = key;
    const byIndex = new Map();
    for (const event of events) {
      const i = candleIndexFor(data, event.exDate, interval());
      if (i < 0) {
        continue;
      }
      if (!byIndex.has(i)) {
        byIndex.set(i, []);
      }
      byIndex.get(i).push(event);
    }
    groups = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([i, list]) => ({ time: data[i].time, events: list }));
  }

  function layout() {
    regroup();
    const ts = view.chart.timeScale();
    clusters = [];
    for (const group of groups) {
      const x = ts.timeToCoordinate(group.time);
      if (x == null) {
        continue;
      }
      const last = clusters.at(-1);
      if (last && x - last.x < radius * 2 + 2) {
        last.events.push(...group.events);
        continue;
      }
      clusters.push({ key: `${ID_PREFIX}${group.time}`, x, events: [...group.events] });
    }
  }

  const badgeY = () => paneHeight - radius - 4;
  const isSelected = (cluster) => selectedExDate != null && cluster.events.some((e) => e.exDate === selectedExDate);

  const renderer = {
    draw(target) {
      target.useBitmapCoordinateSpace(({ context: ctx, mediaSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
        paneHeight = mediaSize.height;
        const y = badgeY();
        for (const cluster of clusters) {
          const selected = isSelected(cluster);
          const cx = Math.round(cluster.x * hpr);
          if (selected) {
            ctx.save();
            ctx.strokeStyle = COLORS.dividend;
            ctx.lineWidth = Math.max(1, Math.floor(hpr));
            ctx.setLineDash([3 * hpr, 3 * hpr]);
            ctx.beginPath();
            ctx.moveTo(cx + 0.5, 0);
            ctx.lineTo(cx + 0.5, (y - radius) * vpr);
            ctx.stroke();
            ctx.restore();
          }
          ctx.beginPath();
          ctx.arc(cx, y * vpr, radius * hpr, 0, Math.PI * 2);
          ctx.fillStyle = selected ? COLORS.dividend : COLORS.tile;
          ctx.fill();
          ctx.lineWidth = 1.5 * hpr;
          ctx.strokeStyle = COLORS.dividend;
          ctx.stroke();
          ctx.fillStyle = selected ? COLORS.dividendInk : COLORS.dividend;
          ctx.font = `700 ${fontSize * vpr}px ${CHART_FONT}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('D', cx, (y + 0.5) * vpr);
        }
      });
    },
  };
  const paneView = { zOrder: () => 'top', renderer: () => renderer };

  const primitive = {
    attached(param) {
      requestUpdate = param.requestUpdate;
    },
    detached() {
      requestUpdate = () => {};
    },
    updateAllViews() {
      layout();
    },
    paneViews() {
      return [paneView];
    },
    hitTest(x, y) {
      const hit = clusterAtPoint(x, y);
      return hit ? { externalId: hit.key, zOrder: 'top', cursorStyle: 'pointer', itemType: 'primitive' } : null;
    },
  };

  function clusterAtPoint(x, y) {
    const reach = radius + 3; // a little slack for fingers
    if (Math.abs(y - badgeY()) > reach) {
      return null;
    }
    return clusters.find((c) => Math.abs(c.x - x) <= reach) || null;
  }

  const onData = () => {
    groupsKey = '';
  };
  view.candles.subscribeDataChanged(onData);
  view.candles.attachPrimitive(primitive);

  return {
    setEvents(list) {
      events = list || [];
      groupsKey = '';
      requestUpdate();
    },
    // Selects the dividend with this ex-date (its badge fills and gets a dotted line), or none.
    select(exDate) {
      selectedExDate = exDate;
      requestUpdate();
    },
    selected() {
      return selectedExDate;
    },
    // The badge a chart click landed on, or null. Touch taps carry no hovered object, so fall back to the point.
    clusterAt(param) {
      const id = param?.hoveredInfo?.objectId ?? param?.hoveredObjectId;
      if (typeof id === 'string' && id.startsWith(ID_PREFIX)) {
        return clusters.find((c) => c.key === id) || null;
      }
      if (!param?.point || (param.paneIndex ?? 0) !== 0) {
        return null;
      }
      return clusterAtPoint(param.point.x, param.point.y);
    },
    // The badge showing the dividend with this ex-date right now ({ key, x, y, radius, events }), or null.
    clusterFor(exDate) {
      const c = clusters.find((cluster) => cluster.events.some((e) => e.exDate === exDate));
      return c ? { key: c.key, x: c.x, y: badgeY(), radius, events: c.events } : null;
    },
    // For tests: the badges as drawn.
    marks() {
      return clusters.map((c) => ({ key: c.key, x: c.x, y: badgeY(), exDates: c.events.map((e) => e.exDate), selected: isSelected(c) }));
    },
    detach() {
      view.candles.unsubscribeDataChanged(onData);
      view.candles.detachPrimitive(primitive);
    },
  };
}
