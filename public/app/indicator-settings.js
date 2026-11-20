import { $ } from './util.js';
import { store } from './state.js';
import { AVERAGE_COLORS, COLORS } from './theme.js';

const DEFAULT_PERIODS = [20, 50, 200];
const MAX_AVERAGES = DEFAULT_PERIODS.length;
const validPeriod = (period) => Number.isSafeInteger(period) && period >= 1;
const validColor = (color) => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color);
const settingsKey = (symbol) => `pd.indicators.${symbol}`;

export function showSymbolVolume(symbol) {
  return store.get(settingsKey(symbol), null)?.volume !== false;
}

function loadSettings(symbol) {
  const saved = store.get(settingsKey(symbol), null);
  const averages = Array.isArray(saved?.averages) ? saved.averages.slice(0, MAX_AVERAGES) : [];
  return {
    volume: saved?.volume !== false,
    rsi: saved?.rsi === true,
    rsiColor: validColor(saved?.rsiColor) ? saved.rsiColor.toLowerCase() : COLORS.rsi,
    averages: averages.map((row, i) => ({
      type: row?.type === 'ema' ? 'ema' : 'sma',
      period: validPeriod(row?.period) ? row.period : DEFAULT_PERIODS[i],
      color: validColor(row?.color) ? row.color.toLowerCase() : AVERAGE_COLORS[i],
    })),
  };
}

export function setupIndicatorSettings(dialog) {
  const button = $('#chart-viewer-indicators', dialog);
  const panel = $('#chart-viewer-indicator-panel', dialog);
  const volume = $('#chart-viewer-volume', panel);
  const rsi = $('#chart-viewer-rsi', panel);
  const rsiColor = $('#chart-viewer-rsi-color', panel);
  const rows = $('#chart-viewer-averages', panel);
  const template = $('#chart-viewer-average-template', panel);
  const count = $('#chart-viewer-average-count', panel);
  const add = $('#chart-viewer-add-average', panel);
  let symbol, settings, renderChart;

  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }

  function saveSettings() {
    renderChart(settings);
    store.set(settingsKey(symbol), settings);
  }

  function renderRows() {
    rows.replaceChildren(...settings.averages.map((average, i) => {
      const row = template.content.firstElementChild.cloneNode(true);
      const type = $('[data-average-type]', row);
      const period = $('[data-average-period]', row);
      const color = $('[data-average-color]', row);
      const remove = $('[data-average-remove]', row);
      type.value = average.type;
      period.value = average.period;
      color.value = average.color;
      type.setAttribute('aria-label', `Type for moving average ${i + 1}`);
      period.setAttribute('aria-label', `Period for moving average ${i + 1}`);
      color.setAttribute('aria-label', `Color for moving average ${i + 1}`);
      remove.setAttribute('aria-label', `Remove moving average ${i + 1}`);
      type.addEventListener('change', () => {
        average.type = type.value;
        saveSettings();
      });
      period.addEventListener('change', () => {
        if (!validPeriod(period.valueAsNumber)) {
          period.value = average.period;
          return;
        }
        average.period = period.valueAsNumber;
        saveSettings();
      });
      color.addEventListener('change', () => {
        average.color = color.value;
        saveSettings();
      });
      remove.addEventListener('click', () => {
        settings.averages.splice(i, 1);
        renderRows();
        saveSettings();
        add.focus();
      });
      return row;
    }));
    count.textContent = `${settings.averages.length} of ${MAX_AVERAGES}`;
    add.disabled = settings.averages.length >= MAX_AVERAGES;
  }

  button.addEventListener('click', () => setOpen(panel.hidden));
  volume.addEventListener('change', () => {
    settings.volume = volume.checked;
    saveSettings();
  });
  rsi.addEventListener('change', () => {
    settings.rsi = rsi.checked;
    saveSettings();
  });
  rsiColor.addEventListener('change', () => {
    settings.rsiColor = rsiColor.value;
    saveSettings();
  });
  add.addEventListener('click', () => {
    if (settings.averages.length >= MAX_AVERAGES) {
      return;
    }
    const period = DEFAULT_PERIODS.find((value) => !settings.averages.some((average) => average.period === value));
    const color = AVERAGE_COLORS.find((value) => !settings.averages.some((average) => average.color === value));
    settings.averages.push({ type: 'sma', period, color });
    renderRows();
    saveSettings();
    $('[data-average-type]', rows.lastElementChild).focus();
  });

  return {
    open(id, apply) {
      symbol = id;
      settings = loadSettings(symbol);
      renderChart = apply;
      volume.checked = settings.volume;
      rsi.checked = settings.rsi;
      rsiColor.value = settings.rsiColor;
      setOpen(false);
      renderRows();
      renderChart(settings);
    },
    close() {
      setOpen(false);
      renderChart = null;
    },
  };
}
