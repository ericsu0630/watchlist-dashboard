import { TIMEFRAMES, DEFAULT_TIMEFRAME } from '../timeframes.js';
import { isSymbol } from '../symbols.js';
import { $ } from './util.js';

// What the board is showing: tabs, symbols, interval, candle width. Saved in localStorage.

const DEFAULTS = ['NASDAQ:AAPL', 'NASDAQ:NVDA', 'NASDAQ:MSFT', 'TWSE:2330', 'AMEX:SPY', 'NASDAQ:QQQ', 'BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'];

// ------------------------------------------------------------ State
export const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};
export const state = {
  tf: store.get('pd.tf', DEFAULT_TIMEFRAME),
};
if (!TIMEFRAMES.some((t) => t.id === state.tf)) state.tf = DEFAULT_TIMEFRAME;

// Candle width (Lightweight Charts "bar spacing": px from one candle's centre to the next), shared by tile charts.
// Enlarged charts start near this width but keep their own view. The slider limits match index.html.
export const ZOOM_MIN = 1, ZOOM_MAX = 15, ZOOM_DEFAULT = 5;
export const clampZoom = (px) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(Number(px) || ZOOM_DEFAULT)));
state.zoom = clampZoom(store.get('pd.zoomPx', ZOOM_DEFAULT));

// Sort order: 'asc' / 'desc' by ticker, 'gain' / 'loss' by day change %, or 'none' once the user arranges
// tiles themselves. Each tab has its own.
export const SORT_MODES = ['asc', 'desc', 'gain', 'loss', 'none'];

// Tabs group the symbols: [{ id, name, symbols, sort }]. A symbol is in at most one tab.
// Boards from before tabs existed (pd.symbols, pd.sort) become a single "Default" tab.
export const TAB_NAME_MAX = 40;
export const newTabId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
function loadTabs() {
  let raw = store.get('pd.tabs', null);
  if (!Array.isArray(raw) || !raw.length) {
    raw = [{ id: 'default', name: 'Default', symbols: store.get('pd.symbols', null) ?? DEFAULTS.slice(), sort: store.get('pd.sort', 'none') }];
  }
  const seenSymbols = new Set(), seenIds = new Set();
  const tabs = raw.filter((t) => t && typeof t === 'object').map((t) => {
    let id = typeof t.id === 'string' && t.id ? t.id : newTabId();
    if (seenIds.has(id)) id = newTabId();
    seenIds.add(id);
    return {
      id,
      name: (typeof t.name === 'string' && t.name.trim() ? t.name.trim() : 'Untitled').slice(0, TAB_NAME_MAX),
      // Keep the first copy of any symbol that somehow appears twice.
      symbols: (Array.isArray(t.symbols) ? t.symbols : []).filter((s) => isSymbol(s) && !seenSymbols.has(s) && seenSymbols.add(s)),
      sort: SORT_MODES.includes(t.sort) ? t.sort : 'none',
    };
  });
  return tabs.length ? tabs : [{ id: 'default', name: 'Default', symbols: [], sort: 'none' }];
}
state.tabs = loadTabs();
state.activeTab = store.get('pd.activeTab', null);
if (!state.tabs.some((t) => t.id === state.activeTab)) state.activeTab = state.tabs[0].id;

export const activeTab = () => state.tabs.find((t) => t.id === state.activeTab);
export const tabById = (id) => state.tabs.find((t) => t.id === id);
export const tabOf = (sym) => state.tabs.find((t) => t.symbols.includes(sym));
export const allSymbols = () => state.tabs.flatMap((t) => t.symbols);
// The grid, sorting, reordering and live data all work on the open tab, through these two.
Object.defineProperty(state, 'symbols', { get: () => activeTab().symbols, set: (v) => { activeTab().symbols = v; } });
Object.defineProperty(state, 'sort', { get: () => activeTab().sort, set: (v) => { activeTab().sort = v; } });

export const save = () => {
  store.set('pd.tabs', state.tabs); store.set('pd.activeTab', state.activeTab);
  store.set('pd.tf', state.tf); store.set('pd.zoomPx', state.zoom);
  store.set('pd.symbols', allSymbols()); // flat list, still readable by older versions of the page
};
save();

export const tiles = new Map(); // symbol -> Tile
export const grid = $('#grid');

export const tfPreset = (id = state.tf) => TIMEFRAMES.find((t) => t.id === id);
export const isIntraday = (id) => /^\d+$/.test(tfPreset(id).interval);
