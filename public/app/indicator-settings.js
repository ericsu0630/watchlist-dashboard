import { $ } from './util.js';
import { store } from './state.js';
import { AVERAGE_COLORS, COLORS } from './theme.js';

const DEFAULT_PERIODS = [20, 50, 200];
const MAX_AVERAGES = DEFAULT_PERIODS.length;
const MAX_PRICE_LINES = 5;
const validPeriod = (period) => Number.isSafeInteger(period) && period >= 1;
const validColor = (color) => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color);
const settingsKey = (symbol) => `pd.indicators.${symbol}`;

export function parseIndicatorSettings(raw) {
  const settings = {};
  if (typeof raw?.volume === 'boolean') {
    settings.volume = raw.volume;
  }
  if (typeof raw?.rsi === 'boolean') {
    settings.rsi = raw.rsi;
  }
  if (validColor(raw?.rsiColor)) {
    settings.rsiColor = raw.rsiColor.toLowerCase();
  }
  if (raw?.gridIndicator === 'volume' || raw?.gridIndicator === 'rsi') {
    settings.gridIndicator = raw.gridIndicator;
  }
  if (Array.isArray(raw?.averages)) {
    const averages = [];
    for (const row of raw.averages) {
      if ((row?.type !== 'sma' && row?.type !== 'ema') || !validPeriod(row.period)) {
        continue;
      }
      averages.push({
        type: row.type, period: row.period,
        color: validColor(row.color) ? row.color.toLowerCase() : AVERAGE_COLORS[averages.length],
        showOnGrid: row.showOnGrid !== false,
      });
      if (averages.length === MAX_AVERAGES) {
        break;
      }
    }
    if (averages.length || !raw.averages.length) {
      settings.averages = averages;
    }
  }
  if (Array.isArray(raw?.priceLines)) {
    const priceLines = [];
    for (const row of raw.priceLines) {
      if (!Number.isFinite(row?.price)) {
        continue;
      }
      priceLines.push({
        price: row.price,
        color: validColor(row.color) ? row.color.toLowerCase() : COLORS.priceLine,
        showOnGrid: row.showOnGrid !== false,
      });
      if (priceLines.length === MAX_PRICE_LINES) {
        break;
      }
    }
    if (priceLines.length || !raw.priceLines.length) {
      settings.priceLines = priceLines;
    }
  }
  return settings;
}

export function readIndicatorSettings(symbol) {
  return {
    volume: true, rsi: false, rsiColor: COLORS.rsi, gridIndicator: 'volume', averages: [], priceLines: [],
    ...parseIndicatorSettings(store.get(settingsKey(symbol), null)),
  };
}

export function writeIndicatorSettings(symbol, settings) {
  store.set(settingsKey(symbol), settings);
}

export function setupIndicatorSettings(dialog) {
  const button = $('#chart-viewer-indicators', dialog);
  const panel = $('#chart-viewer-indicator-panel', dialog);
  const ok = $('#chart-viewer-indicators-ok', panel);
  const volume = $('#chart-viewer-volume', panel);
  const rsi = $('#chart-viewer-rsi', panel);
  const rsiColor = $('#chart-viewer-rsi-color', panel);
  const gridChoice = $('#chart-viewer-grid-choice', panel);
  const gridIndicator = $('#chart-viewer-grid-indicator', gridChoice);
  const rows = $('#chart-viewer-averages', panel);
  const template = $('#chart-viewer-average-template', panel);
  const count = $('#chart-viewer-average-count', panel);
  const add = $('#chart-viewer-add-average', panel);
  const priceRows = $('#chart-viewer-price-lines', panel);
  const priceTemplate = $('#chart-viewer-price-line-template', panel);
  const priceCount = $('#chart-viewer-price-line-count', panel);
  const addPriceLine = $('#chart-viewer-add-price-line', panel);
  let symbol, settings, renderChart, nextPrice, selectedLine;

  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }

  function applySettings() {
    gridChoice.hidden = !(settings.volume && settings.rsi);
    renderChart(settings, settings.priceLines.indexOf(selectedLine));
  }

  function saveSettings() {
    applySettings();
    writeIndicatorSettings(symbol, settings);
  }

  function highlightPriceRow() {
    for (const [i, row] of [...priceRows.children].entries()) {
      row.classList.toggle('is-selected', settings.priceLines[i] === selectedLine);
    }
  }

  function editPriceLine(index, price) {
    const line = settings?.priceLines[index];
    if (!line || !renderChart) {
      return;
    }
    const row = priceRows.children[index];
    if (Number.isFinite(price)) {
      line.price = price;
      $('[data-price-line-price]', row).value = price;
      saveSettings();
      return;
    }
    selectedLine = line;
    setOpen(true);
    highlightPriceRow();
    applySettings();
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderPriceRows() {
    priceRows.replaceChildren(...settings.priceLines.map((line, i) => {
      const row = priceTemplate.content.firstElementChild.cloneNode(true);
      const price = $('[data-price-line-price]', row);
      const color = $('[data-price-line-color]', row);
      const grid = $('[data-price-line-grid]', row);
      const remove = $('[data-price-line-remove]', row);
      row.setAttribute('aria-label', `Horizontal line ${i + 1}`);
      price.value = line.price;
      color.value = line.color;
      grid.checked = line.showOnGrid;
      price.setAttribute('aria-label', `Price for horizontal line ${i + 1}`);
      color.setAttribute('aria-label', `Color for horizontal line ${i + 1}`);
      grid.setAttribute('aria-label', `Show horizontal line ${i + 1} on grid`);
      remove.setAttribute('aria-label', `Delete horizontal line ${i + 1}`);
      row.addEventListener('change', ({ target }) => {
        if (target === price && !Number.isFinite(price.valueAsNumber)) {
          price.value = line.price;
          return;
        }
        Object.assign(line, { price: target === price ? price.valueAsNumber : line.price, color: color.value, showOnGrid: grid.checked });
        saveSettings();
      });
      remove.addEventListener('click', () => {
        settings.priceLines.splice(i, 1);
        if (selectedLine === line) {
          selectedLine = null;
        }
        renderPriceRows();
        saveSettings();
        addPriceLine.focus();
      });
      return row;
    }));
    highlightPriceRow();
    priceCount.textContent = `${settings.priceLines.length} of ${MAX_PRICE_LINES}`;
    addPriceLine.disabled = settings.priceLines.length >= MAX_PRICE_LINES;
  }

  function renderRows() {
    rows.replaceChildren(...settings.averages.map((average, i) => {
      const row = template.content.firstElementChild.cloneNode(true);
      const type = $('[data-average-type]', row);
      const period = $('[data-average-period]', row);
      const color = $('[data-average-color]', row);
      const grid = $('[data-average-grid]', row);
      const remove = $('[data-average-remove]', row);
      type.value = average.type;
      period.value = average.period;
      color.value = average.color;
      grid.checked = average.showOnGrid;
      type.setAttribute('aria-label', `Type for moving average ${i + 1}`);
      period.setAttribute('aria-label', `Period for moving average ${i + 1}`);
      color.setAttribute('aria-label', `Color for moving average ${i + 1}`);
      grid.setAttribute('aria-label', `Show moving average ${i + 1} on grid`);
      remove.setAttribute('aria-label', `Delete moving average ${i + 1}`);
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
      grid.addEventListener('change', () => {
        average.showOnGrid = grid.checked;
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
  ok.addEventListener('click', () => {
    button.focus({ preventScroll: true });
    setOpen(false);
  });
  dialog.addEventListener('pointerdown', ({ target }) => {
    if (!panel.hidden && !panel.contains(target) && !button.contains(target) && !target.closest('.price-line-handle')) {
      panel.querySelector(':focus')?.blur();
      setOpen(false);
    }
  }, true);
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
  gridIndicator.addEventListener('change', () => {
    settings.gridIndicator = gridIndicator.value;
    saveSettings();
  });
  add.addEventListener('click', () => {
    if (settings.averages.length >= MAX_AVERAGES) {
      return;
    }
    const period = DEFAULT_PERIODS.find((value) => !settings.averages.some((average) => average.period === value));
    const color = AVERAGE_COLORS.find((value) => !settings.averages.some((average) => average.color === value));
    settings.averages.push({ type: 'sma', period, color, showOnGrid: true });
    renderRows();
    saveSettings();
    $('[data-average-type]', rows.lastElementChild).focus();
  });
  addPriceLine.addEventListener('click', () => {
    const { priceLines } = settings;
    if (priceLines.length >= MAX_PRICE_LINES) {
      return;
    }
    selectedLine = { price: nextPrice(priceLines), color: COLORS.priceLine, showOnGrid: true };
    priceLines.push(selectedLine);
    renderPriceRows();
    saveSettings();
    $('[data-price-line-price]', priceRows.lastElementChild).focus();
  });

  return {
    editPriceLine,
    open(id, apply, suggestPrice) {
      symbol = id;
      settings = readIndicatorSettings(symbol);
      renderChart = apply;
      nextPrice = suggestPrice;
      selectedLine = null;
      volume.checked = settings.volume;
      rsi.checked = settings.rsi;
      rsiColor.value = settings.rsiColor;
      gridIndicator.value = settings.gridIndicator;
      setOpen(false);
      renderRows();
      renderPriceRows();
      applySettings();
    },
    close() {
      setOpen(false);
      renderChart = nextPrice = selectedLine = null;
    },
  };
}
