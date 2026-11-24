import { $, announce } from './util.js';
import { TIMEFRAMES } from '../timeframes.js';
import { isSymbol } from '../symbols.js';
import { state, allSymbols, save, tiles, SORT_MODES, TAB_NAME_MAX, newTabId, clampZoom } from './state.js';
import { parseIndicatorSettings, readIndicatorSettings, writeIndicatorSettings } from './indicator-settings.js';
import { render } from './board.js';
import { applySort, LIVE_SORTS, resortSoon, setSort } from './sort.js';
import { menu, openMenu, closeMenu, choiceDialog } from './menu.js';
import { warmNews } from './news.js';
import { sendWatch } from './live.js';
import { setTimeframe } from './timeframe.js';
import { setZoom } from './zoom.js';
import { account, openAccountDialog, signOut, syncNow } from './account.js';

// Export tabs, board-wide chart settings and each symbol's indicators.
function exportBoard() {
  const tabs = state.tabs.map((t) => ({ name: t.name, sort: t.sort, symbols: [...t.symbols] }));
  const indicators = Object.fromEntries(allSymbols().map((symbol) => [symbol, readIndicatorSettings(symbol)]));
  const settings = { candleInterval: state.tf, candleWidthPx: state.zoom, indicators };
  const data = { app: 'watchlist-dashboard', version: 1, exportedAt: new Date().toISOString(), settings, tabs };
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `watchlist-${day}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  const n = tabs.reduce((sum, t) => sum + t.symbols.length, 0);
  announce(`Exported ${n} symbol${n === 1 ? '' : 's'} in ${tabs.length} tab${tabs.length === 1 ? '' : 's'}`);
}

// Import: a file from Export (or the same shape). A dialog asks whether to merge it into the board or
// replace the board with it.
const importInput = $('#import-file');
const IMPORT_MAX_BYTES = 1_000_000;
function parseImport(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('This file isn’t valid JSON.'); }
  // Our export, or a bare list of symbols.
  const raw = Array.isArray(data?.tabs) ? data.tabs : Array.isArray(data) ? [{ name: 'Imported', symbols: data }] : null;
  if (!raw) throw new Error('This doesn’t look like a Watchlist export: there’s no list of tabs in it.');
  const seen = new Set();
  let invalid = 0, repeated = 0;
  const tabs = raw.filter((t) => t && typeof t === 'object').map((t) => ({
    name: (typeof t.name === 'string' && t.name.trim() ? t.name.trim() : 'Imported').slice(0, TAB_NAME_MAX),
    sort: SORT_MODES.includes(t.sort) ? t.sort : 'none',
    symbols: (Array.isArray(t.symbols) ? t.symbols : []).flatMap((s) => {
      // TradingView ids are uppercase (NASDAQ:AAPL); a hand-edited "nasdaq:aapl" means the same symbol.
      const sym = typeof s === 'string' ? s.trim().toUpperCase() : '';
      if (!isSymbol(sym)) { invalid++; return []; }
      if (seen.has(sym)) { repeated++; return []; } // a symbol lives in one tab: first one wins
      seen.add(sym);
      return [sym];
    }),
  }));
  if (!tabs.length) throw new Error('There are no tabs in this file.');
  // Chart settings, when the file has them (exports do): used only if they're valid.
  const st = data && !Array.isArray(data) && data.settings && typeof data.settings === 'object' ? data.settings : {};
  const settings = {};
  if (TIMEFRAMES.some((t) => t.id === st.candleInterval)) settings.tf = st.candleInterval;
  if (typeof st.candleWidthPx === 'number' && Number.isFinite(st.candleWidthPx)) settings.zoom = clampZoom(st.candleWidthPx);
  const indicators = new Map();
  if (st.indicators && typeof st.indicators === 'object' && !Array.isArray(st.indicators)) {
    for (const [id, rawSettings] of Object.entries(st.indicators)) {
      const symbol = id.trim().toUpperCase();
      if (!seen.has(symbol) || indicators.has(symbol)) {
        continue;
      }
      const prefs = parseIndicatorSettings(rawSettings);
      if (Object.keys(prefs).length) {
        indicators.set(symbol, prefs);
      }
    }
  }
  settings.indicators = indicators;
  return { tabs, invalid, repeated, symbols: seen.size, settings };
}

async function importBoard(file) {
  const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
  let parsed;
  try {
    if (file.size > IMPORT_MAX_BYTES) throw new Error('This file is too large to be a Watchlist export.');
    parsed = parseImport(await file.text());
  } catch (err) {
    await choiceDialog({ title: 'Can’t import this file', body: `${file.name}: ${err.message} Nothing was changed.`, choices: [{ value: 'ok', label: 'OK' }] });
    return;
  }
  const { tabs, invalid, repeated, symbols, settings } = parsed;
  // The file's candle interval and width apply with either choice; mention only what would change.
  const changes = [
    settings.tf && settings.tf !== state.tf && `candle interval to ${TIMEFRAMES.find((t) => t.id === settings.tf).label}`,
    settings.zoom != null && settings.zoom !== state.zoom && `candle width to ${settings.zoom} px`,
  ].filter(Boolean);
  const mine = allSymbols().length;
  const skipped = [invalid && `${plural(invalid, 'entry', 'entries')} that ${invalid === 1 ? 'isn’t a symbol' : 'aren’t symbols'}`, repeated && `${plural(repeated, 'repeated symbol')}`].filter(Boolean);
  const choice = await choiceDialog({
    title: `Import ${plural(tabs.length, 'tab')} and ${plural(symbols, 'symbol')}?`,
    body: `From ${file.name}. Replace swaps your current ${plural(state.tabs.length, 'tab')} and ${plural(mine, 'symbol')} for these. `
      + 'Merge keeps yours and adds these: tabs with the same name are combined, symbols you already have stay where they are, and tabs that would end up empty are left out.'
      + (changes.length ? ` Either way, it also sets the ${changes.join(' and ')}.` : '')
      + (settings.indicators.size ? ` Both options also apply the file’s indicator settings for ${plural(settings.indicators.size, 'symbol')}.` : '')
      + (skipped.length ? ` Skipped: ${skipped.join(' and ')}.` : ''),
    choices: [{ value: 'cancel', label: 'Cancel' }, { value: 'merge', label: 'Merge with my tabs' }, { value: 'replace', label: 'Replace my tabs', danger: true }],
  });
  if (choice === 'replace') {
    state.tabs = tabs.map((t) => ({ id: newTabId(), ...t }));
    if (!state.tabs.length) state.tabs = [{ id: newTabId(), name: 'Default', symbols: [], sort: 'none' }];
    state.activeTab = state.tabs[0].id;
    announce(`Imported ${plural(tabs.length, 'tab')} and ${plural(symbols, 'symbol')}, replacing your board`);
  } else if (choice === 'merge') {
    let added = 0, kept = 0, newTabs = 0, emptyTabs = 0;
    // Symbols already on the board, matched ignoring case, stay where they are.
    const onBoard = new Set(allSymbols().map((s) => s.toUpperCase()));
    for (const t of tabs) {
      const fresh = t.symbols.filter((sym) => !onBoard.has(sym));
      kept += t.symbols.length - fresh.length;
      let target = state.tabs.find((x) => x.name.toLowerCase() === t.name.toLowerCase());
      if (!target) {
        // A new tab only if something would go in it.
        if (!fresh.length) { emptyTabs++; continue; }
        target = { id: newTabId(), name: t.name, symbols: [], sort: t.sort };
        state.tabs.push(target);
        newTabs++;
      }
      for (const sym of fresh) { target.symbols.push(sym); onBoard.add(sym); added++; }
      applySort(target);
    }
    announce(`Merged: added ${plural(added, 'symbol')} and ${plural(newTabs, 'new tab')}`
      + (kept ? `; ${plural(kept, 'symbol')} you already had stayed put` : '')
      + (emptyTabs ? `; ${plural(emptyTabs, 'tab')} left out because ${emptyTabs === 1 ? 'it' : 'they'} would have been empty` : ''));
  } else {
    return;
  }
  for (const [symbol, prefs] of settings.indicators) {
    const indicators = { ...readIndicatorSettings(symbol), ...prefs };
    writeIndicatorSettings(symbol, indicators);
    tiles.get(symbol)?.setGridIndicators(indicators);
  }
  setSort(state.sort);
  save();
  render();
  sendWatch();
  if (settings.tf) setTimeframe(settings.tf); // both no-ops when unchanged
  if (settings.zoom != null) setZoom(settings.zoom);
  warmNews();
  if (LIVE_SORTS.has(state.sort)) resortSoon();
  scrollTo(0, 0);
}

export function setupImportExport() {
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    importInput.value = ''; // so choosing the same file again still counts as a change
    if (file) importBoard(file);
  });
  // The ⋮ button at the end of the tabs row: Import and Export.
  const moreBtn = $('#tab-more');
  moreBtn.addEventListener('click', () => {
    if (!menu.hidden && menu.dataset.for === 'more') { closeMenu(); return; }
    const statusText = { synced: 'Synced', syncing: 'Syncing…', offline: 'Offline' }[account.status];
    const accountItems = account.user
      ? [
        { heading: `Signed in as ${account.user}` },
        { label: 'Sync now', hint: statusText, action: syncNow },
        { label: 'Sign out', action: signOut },
      ]
      : [{ label: 'Sign in to sync…', action: openAccountDialog }];
    openMenu({}, moreBtn, 'Account, import and export', [
      ...accountItems,
      { separator: true },
      { label: 'Import…', hint: '.json', action: () => importInput.click() },
      { label: 'Export', hint: '.json', action: exportBoard },
    ], 'more');
  });
}
