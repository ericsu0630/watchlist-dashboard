import { $, announce, ticker } from './util.js';
import { state, allSymbols, activeTab, tabById, tabOf, save, tiles, grid } from './state.js';
import { Tile } from './tile.js';
import { renderTabs, switchTab, tabButton, flashTab, createTab, startRename } from './tabs.js';
import { applySort, LIVE_SORTS, resortSoon, setSort } from './sort.js';
import { news, warmNews, loadNews } from './news.js';
import { sendWatch } from './live.js';
import { openMenu } from './menu.js';

export function render() {
  // Tiles exist for symbols in any tab; only the open tab's are in the grid. The others keep their
  // candles in memory (their charts are freed once they leave the page), so switching back is quick.
  const all = new Set(allSymbols());
  for (const [sym, tile] of tiles) if (!all.has(sym)) { tile.destroy(); tiles.delete(sym); }
  const shown = state.symbols;
  for (const el of [...grid.children]) if (!shown.includes(el.dataset.symbol)) el.remove();
  shown.forEach((sym, i) => {
    let tile = tiles.get(sym);
    if (!tile) { tile = new Tile(sym); tiles.set(sym, tile); }
    if (grid.children[i] !== tile.el) grid.insertBefore(tile.el, grid.children[i] || null);
  });
  const total = all.size;
  $('#empty').hidden = shown.length > 0 || news.open;
  if (!shown.length) {
    const named = state.tabs.length > 1 || activeTab().name !== 'Default';
    $('#empty-title').textContent = total && named ? `Nothing in “${activeTab().name}” yet` : 'Nothing on your board yet';
    $('#empty-text').textContent = total
      ? 'Search above to add a symbol to this tab, or right-click a tile in another tab and move it here. Or pick one to begin:'
      : 'Search for a stock, ETF, index, currency pair or crypto pair above to start tracking it. Or pick one to begin:';
  }
  $('#count').textContent = total ? `${total} symbol${total === 1 ? '' : 's'}` : '';
  renderTabs();
}

// A symbol can only be in one tab. If it's already in one, that tab opens and the tile is pointed out;
// otherwise it joins the open tab.
export function addSymbol(sym) {
  const home = tabOf(sym);
  if (home && home !== activeTab()) switchTab(home.id, { scroll: false });
  if (!home) {
    state.symbols.push(sym); // at the end when unsorted…
    applySort(); // …or in its sorted place
    save();
    render();
    sendWatch();
    if (!news.open) warmNews();
    if (LIVE_SORTS.has(state.sort)) resortSoon(); // its place depends on a price that's on its way
  }
  // In the news view, stay there and include the new symbol's headlines.
  if (news.open) { if (!home) loadNews(); return; }
  const tile = tiles.get(sym);
  tile.el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  tile.el.classList.remove('flash'); void tile.el.offsetWidth; tile.el.classList.add('flash');
  if (home) announce(`${ticker(sym)} is already in ${home.name}`);
}
export function removeSymbol(sym) {
  const tab = tabOf(sym);
  if (!tab) return;
  tab.symbols = tab.symbols.filter((s) => s !== sym);
  save();
  render();
  sendWatch();
}
export function moveSymbol(sym, delta) {
  const i = state.symbols.indexOf(sym);
  const j = Math.max(0, Math.min(state.symbols.length - 1, i + delta));
  if (i === j) return;
  state.symbols.splice(i, 1);
  state.symbols.splice(j, 0, sym);
  setSort('none');
  save();
  render();
  tiles.get(sym).ui.grip.focus();
}
// Moves a symbol into another tab, in that tab's sorted place (or at its end when it's unsorted).
export function moveToTab(sym, tabId, { hadFocus = null } = {}) {
  const from = tabOf(sym), to = tabById(tabId);
  if (!from || !to || from === to) return;
  const wasShown = from === activeTab();
  const next = wasShown ? state.symbols[state.symbols.indexOf(sym) + 1] ?? state.symbols[state.symbols.indexOf(sym) - 1] : null;
  // Was the tile focused (before any menu took focus)?
  hadFocus = wasShown && (hadFocus ?? tiles.get(sym)?.el.contains(document.activeElement));
  from.symbols = from.symbols.filter((s) => s !== sym);
  to.symbols.push(sym);
  applySort(to);
  save();
  render();
  sendWatch();
  flashTab(to.id);
  announce(`Moved ${ticker(sym)} to ${to.name}`);
  // Keyboard users keep their place: the neighbouring tile, or the tab itself when this tab is now empty.
  if (hadFocus) (next ? tiles.get(next).ui.grip : tabButton(state.activeTab))?.focus();
}

// Right-click a tile (or press the context-menu key / Shift+F10 on it): move it to another tab, or remove it.
export function setupBoard() {
  grid.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.tile');
    if (!el) return;
    e.preventDefault();
    const sym = el.dataset.symbol;
    const hadFocus = el.contains(document.activeElement);
    const others = state.tabs.filter((t) => t.id !== state.activeTab);
    openMenu(e, $('.tile-head', el), `${ticker(sym)} actions`, [
      { heading: `Move ${ticker(sym)} to` },
      ...others.map((t) => ({ label: t.name, hint: String(t.symbols.length), action: () => moveToTab(sym, t.id, { hadFocus }) })),
      { label: 'New tab…', action: () => { const t = createTab({ open: false }); moveToTab(sym, t.id); startRename(t.id); } },
      { separator: true },
      { label: `Remove ${ticker(sym)}`, danger: true, action: () => removeSymbol(sym) },
    ]);
  });
}
