import { $ } from './util.js';
import { TIMEFRAMES } from '../timeframes.js';
import { state, save, tiles } from './state.js';
import { chartViewer, setChartViewerTimeframe } from './chart-viewer.js';
import { sendWatch } from './live.js';

// ------------------------------------------------------------ Timeframe
const tfEl = $('#tf');
function setupTfButtons(group, getSelected, select) {
  for (const t of TIMEFRAMES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'radio';
    b.textContent = t.label;
    b.title = t.hint;
    b.dataset.tf = t.id;
    b.addEventListener('click', () => select(t.id));
    group.append(b);
  }
  group.addEventListener('keydown', (e) => {
    const direction = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!direction) {
      return;
    }
    e.preventDefault();
    const i = TIMEFRAMES.findIndex((t) => t.id === getSelected());
    const next = (i + direction + TIMEFRAMES.length) % TIMEFRAMES.length;
    select(TIMEFRAMES[next].id);
    group.children[next].focus();
  });
  syncTfButtons(group, getSelected());
}
export function syncTfButtons(group, selected) {
  for (const b of group.children) {
    const on = b.dataset.tf === selected;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}
export function setTimeframe(id) {
  if (id === state.tf) return;
  state.tf = id;
  save();
  syncTfButtons(tfEl, state.tf);
  for (const tile of tiles.values()) tile.applyTimeframe();
  sendWatch();
}

export function setupTimeframe() {
  setupTfButtons(tfEl, () => state.tf, setTimeframe);
  setupTfButtons(chartViewer.intervals, () => chartViewer.tf, setChartViewerTimeframe);
}
