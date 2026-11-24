// The Dividends panel in the enlarged chart. Tapping a D badge selects it (dotted line) and opens the panel
// above it with that badge's dividends; tapping elsewhere, ×, or Esc closes it.
import { $ } from './util.js';

const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const dateText = (iso) => `${weekday.format(new Date(`${iso}T00:00:00Z`))} ${iso}`;
const GAP = 10; // between the panel and its badge
const EDGE = 8; // kept clear of the chart's edges

function rows(event) {
  const dl = document.createElement('dl');
  const add = (label, value) => {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    dl.append(dt, dd);
  };
  add('Ex-dividend date', dateText(event.exDate));
  if (event.cash != null) {
    add('Amount', `${event.cash} TWD`);
  }
  if (event.stock != null) {
    add('Stock dividend', `${event.stock} TWD in shares`);
  }
  add('Payment date', event.payDate ? dateText(event.payDate) : event.stockPayDate ? dateText(event.stockPayDate) : 'Not announced');
  return dl;
}

export function setupDividendPanel(dialog) {
  const panel = $('#chart-viewer-dividend', dialog);
  const list = $('#chart-viewer-dividend-list', panel);
  const close = $('#chart-viewer-dividend-close', panel);
  const body = panel.parentElement;
  let view = null; // { chart, layer } of the open enlarged chart
  let shownKey = null; // the badge whose dividends are listed
  let frame = 0;

  function hide() {
    view?.layer.select(null);
    panel.hidden = true;
    shownKey = null;
  }

  // Puts the panel above the selected badge; hides it while that badge is off screen.
  function place() {
    const exDate = view?.layer.selected();
    const cluster = exDate ? view.layer.clusterFor(exDate) : null;
    if (!cluster) {
      panel.hidden = true;
      return;
    }
    if (cluster.key !== shownKey) {
      shownKey = cluster.key;
      list.replaceChildren(...[...cluster.events].reverse().map(rows));
    }
    panel.hidden = false;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = Math.max(EDGE, Math.min(cluster.x - width / 2, body.clientWidth - width - EDGE));
    const top = Math.max(EDGE, cluster.y - cluster.radius - GAP - height);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  // After the chart has redrawn (badge positions are worked out while drawing).
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(place);
    });
  }

  close.addEventListener('click', () => hide());
  // Esc closes the panel first, then (pressed again) the enlarged chart. Stopping the key is what reliably
  // keeps the dialog open; the cancel handler covers other ways of closing it (such as Android's back).
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      e.preventDefault();
      e.stopPropagation();
      hide();
    }
  }, true);
  dialog.addEventListener('cancel', (e) => {
    if (!panel.hidden) {
      e.preventDefault();
      hide();
    }
  });

  return {
    attach(series, layer) {
      view = { chart: series.chart, layer };
      hide();
      const onClick = (param) => {
        const cluster = layer.clusterAt(param);
        if (cluster) {
          layer.select(cluster.events.at(-1).exDate);
          shownKey = null;
          schedule();
        } else if (layer.selected()) {
          hide();
        }
      };
      series.chart.subscribeClick(onClick);
      series.chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
      series.chart.timeScale().subscribeSizeChange(schedule);
      series.candles.subscribeDataChanged(schedule);
    },
    // Selects the dividend with this ex-date and opens the panel for it (from a tap on a tile's badge).
    open(exDate) {
      view?.layer.select(exDate);
      shownKey = null;
      schedule();
    },
    detach() {
      hide();
      cancelAnimationFrame(frame);
      view = null;
    },
  };
}
