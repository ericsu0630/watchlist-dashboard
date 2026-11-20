import { $, splitSymbol, reducedMotion } from './util.js';
import { state, activeTab, save, tiles, grid } from './state.js';
import { render } from './board.js';
import { menu, openMenu, closeMenu } from './menu.js';
import { dragSym } from './drag.js';
import { renaming } from './tabs.js';
import { news } from './news.js';

const tickerCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function compareSymbols(a, b) {
  const [ea, ta] = splitSymbol(a), [eb, tb] = splitSymbol(b);
  return tickerCollator.compare(ta, tb) || tickerCollator.compare(ea, eb);
}
// Day change % of a symbol, from its tile's latest quote; null until a price has arrived.
export function dayChange(sym) {
  const chp = tiles.get(sym)?.quote.chp;
  return Number.isFinite(chp) ? chp : null;
}
export const LIVE_SORTS = new Set(['gain', 'loss']); // orders that change as prices move
function comparator(mode) {
  if (mode === 'asc') return compareSymbols;
  if (mode === 'desc') return (a, b) => compareSymbols(b, a);
  // Day change: gainers or losers first; symbols without a price yet go last, in ticker order.
  const dir = mode === 'gain' ? -1 : 1;
  return (a, b) => {
    const ca = dayChange(a), cb = dayChange(b);
    if (ca == null || cb == null) return (ca == null) - (cb == null) || compareSymbols(a, b);
    return dir * (ca - cb) || compareSymbols(a, b);
  };
}
export function applySort(tab = activeTab()) {
  if (tab.sort === 'none') return;
  tab.symbols.sort(comparator(tab.sort));
}

// Reorders tiles with a short slide from where each one was, instead of a jump.
function withSlide(change) {
  const before = reducedMotion.matches ? null : new Map([...grid.children].map((el) => [el, el.getBoundingClientRect()]));
  change();
  if (!before) return;
  for (const el of grid.children) {
    const a = before.get(el);
    if (!a) continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2, .7, .2, 1)' });
  }
}

// Day-change sorts are kept current as prices move, but gently: a couple of seconds after prices
// arrive, then at most once a minute, and never while the pointer is over the grid, a menu is open
// or a tile is being dragged (so nothing moves out from under a click). Waiting re-sorts run as soon
// as the pointer leaves the grid.
const RESORT_MS = 60_000;
let pointerOnGrid = false, resortWaiting = false, resortTimer = null;
function resortLive() {
  if (!LIVE_SORTS.has(state.sort) || news.open || document.hidden) return;
  if (pointerOnGrid || dragSym || !menu.hidden || renaming) { resortWaiting = true; return; }
  resortWaiting = false;
  const next = [...state.symbols].sort(comparator(state.sort));
  if (next.join() === state.symbols.join()) return;
  withSlide(() => { state.symbols = next; save(); render(); });
}
export function resortSoon(ms = 2000) {
  clearTimeout(resortTimer);
  resortTimer = setTimeout(resortLive, ms);
}

const sortBtn = $('#sort');
const SORT_UI = {
  asc: { label: 'A–Z', item: 'Ticker A–Z', desc: 'ticker, A to Z' },
  desc: { label: 'Z–A', item: 'Ticker Z–A', desc: 'ticker, Z to A' },
  gain: { label: 'Gainers', item: 'Day change: gainers first', desc: 'day change, gainers first' },
  loss: { label: 'Losers', item: 'Day change: losers first', desc: 'day change, losers first' },
  none: { label: 'Unsorted', desc: 'your own order' },
};
export function setSort(mode) {
  state.sort = mode;
  sortBtn.dataset.sort = mode;
  $('span', sortBtn).textContent = SORT_UI[mode].label;
  const text = `Sort: ${SORT_UI[mode].desc}. Choose how to order this tab.`;
  sortBtn.setAttribute('aria-label', text);
  sortBtn.title = text;
}

export function setupSort() {
  setInterval(resortLive, RESORT_MS);
  grid.addEventListener('pointerenter', () => { pointerOnGrid = true; });
  grid.addEventListener('pointerleave', () => { pointerOnGrid = false; if (resortWaiting) resortSoon(600); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && LIVE_SORTS.has(state.sort)) resortSoon(1500); });
  sortBtn.addEventListener('click', () => {
    if (!menu.hidden && menu.dataset.for === 'sort') { closeMenu(); return; }
    openMenu({}, sortBtn, 'Sort this tab', [
      { heading: 'Sort this tab by' },
      ...['asc', 'desc', 'gain', 'loss'].map((mode) => ({
        label: SORT_UI[mode].item,
        checked: state.sort === mode,
        hint: LIVE_SORTS.has(mode) ? 'Live' : null,
        action: () => {
          setSort(mode);
          withSlide(() => { applySort(); save(); render(); });
          if (LIVE_SORTS.has(mode)) resortSoon(); // pick up prices that arrive in the next moments
        },
      })),
    ], 'sort');
  });
  setSort(state.sort);
  // A day-change order can't be worked out before prices arrive, so the saved order stands until they do.
  if (LIVE_SORTS.has(state.sort)) resortSoon(3000);
  else applySort();
}
