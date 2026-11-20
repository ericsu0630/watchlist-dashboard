import { $, ticker, announce } from './util.js';
import { state, tabById, tabOf, save, grid, TAB_NAME_MAX, newTabId } from './state.js';
import { render, moveToTab } from './board.js';
import { applySort, LIVE_SORTS, resortSoon, setSort, dayChange } from './sort.js';
import { openMenu, confirmDialog } from './menu.js';
import { dragSym } from './drag.js';
import { news } from './news.js';
import { sendWatch } from './live.js';

const tabList = $('#tab-list');
export const tabButton = (id) => tabList.querySelector(`[data-tab="${CSS.escape(id)}"]`);
export let renaming = null; // id of the tab whose name is being edited

export function renderTabs() {
  if (renaming) return; // don't replace the name field while it's being typed in
  const focusedTab = tabList.contains(document.activeElement) ? document.activeElement.dataset.tab : null;
  tabList.replaceChildren(...state.tabs.map((t) => {
    const b = document.createElement('button');
    const on = t.id === state.activeTab;
    b.type = 'button';
    b.role = 'tab';
    b.id = `tab-${t.id}`;
    b.className = 'tab';
    b.dataset.tab = t.id;
    b.tabIndex = on ? 0 : -1;
    b.setAttribute('aria-selected', String(on));
    b.setAttribute('aria-controls', 'grid');
    b.title = 'Double-click to rename. Right-click for more. ← → switch tabs.';
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = t.name;
    const count = document.createElement('span');
    count.className = 'tab-count';
    count.textContent = t.symbols.length;
    count.setAttribute('aria-label', `${t.symbols.length} symbol${t.symbols.length === 1 ? '' : 's'}`);
    b.append(name, count);
    return b;
  }));
  grid.setAttribute('aria-labelledby', `tab-${state.activeTab}`);
  if (focusedTab) tabButton(focusedTab)?.focus();
}

export function switchTab(id, { scroll = true } = {}) {
  if (id === state.activeTab || !tabById(id)) return;
  state.activeTab = id;
  setSort(state.sort); // the sort button shows this tab's setting
  // A day-change tab opens already in order, from the latest prices its tiles have. A tab whose prices
  // aren't known yet (not opened since the page loaded) keeps its saved order until they arrive.
  if (LIVE_SORTS.has(state.sort) && state.symbols.every((s) => dayChange(s) != null)) applySort();
  save();
  render();
  sendWatch();
  if (scroll && !news.open) scrollTo(0, 0);
  if (LIVE_SORTS.has(state.sort)) resortSoon(); // and again once this tab's prices have caught up
}

function uniqueTabName(base) {
  const names = new Set(state.tabs.map((t) => t.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}
export function createTab({ open = true } = {}) {
  const tab = { id: newTabId(), name: uniqueTabName('New tab'), symbols: [], sort: 'none' };
  state.tabs.push(tab);
  save();
  if (open) switchTab(tab.id);
  else render();
  return tab;
}

// Edits a tab's name in place: Enter or leaving the field keeps it, Esc cancels.
export function startRename(id) {
  const tab = tabById(id);
  const b = tabButton(id);
  if (!tab || !b || renaming) return;
  renaming = id;
  const input = document.createElement('input');
  input.className = 'tab-rename';
  input.value = tab.name;
  input.maxLength = TAB_NAME_MAX;
  input.setAttribute('aria-label', 'Tab name');
  input.size = Math.max(6, tab.name.length + 1);
  b.querySelector('.tab-name').replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const name = input.value.trim().slice(0, TAB_NAME_MAX);
    if (keep && name && name !== tab.name) { tab.name = name; save(); }
    renaming = null;
    render(); // also refreshes the empty-tab message, which names the tab
    tabButton(id)?.focus();
  };
  input.addEventListener('input', () => { input.size = Math.max(6, input.value.length + 1); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep typing out of the tab list's arrow keys and the page's "/" shortcut
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

// Any tab can go except the last one left. A tab with symbols asks first, since its symbols go with it.
export async function deleteTab(id) {
  const tab = tabById(id);
  if (!tab || state.tabs.length === 1) return;
  if (tab.symbols.length) {
    const list = tab.symbols.map(ticker);
    const shown = list.length > 6 ? `${list.slice(0, 6).join(', ')} and ${list.length - 6} more` : list.join(', ');
    const ok = await confirmDialog({
      title: `Delete “${tab.name}”?`,
      body: `Its ${list.length} symbol${list.length === 1 ? '' : 's'} (${shown}) will be removed from your board. To keep any, move them to another tab first.`,
      ok: 'Delete tab',
    });
    if (!ok) { tabButton(id)?.focus(); return; }
  }
  const i = state.tabs.indexOf(tab);
  state.tabs.splice(i, 1);
  if (state.activeTab === id) {
    state.activeTab = state.tabs[Math.max(0, i - 1)].id;
    setSort(state.sort);
  }
  save();
  render();
  sendWatch();
  announce(`Deleted ${tab.name}`);
  tabButton(state.activeTab)?.focus();
}

export function flashTab(id) {
  const b = tabButton(id);
  if (!b) return;
  b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
}

export function setupTabs() {
  tabList.addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) switchTab(b.dataset.tab);
  });
  tabList.addEventListener('dblclick', (e) => {
    const b = e.target.closest('.tab');
    if (b) startRename(b.dataset.tab);
  });
  tabList.addEventListener('keydown', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    const i = state.tabs.findIndex((t) => t.id === b.dataset.tab);
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % state.tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + state.tabs.length) % state.tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = state.tabs.length - 1;
    else if (e.key === 'F2') { e.preventDefault(); startRename(b.dataset.tab); return; }
    else if (e.key === 'Delete') { e.preventDefault(); deleteTab(b.dataset.tab); return; }
    if (j == null) return;
    e.preventDefault();
    switchTab(state.tabs[j].id);
    tabButton(state.tabs[j].id)?.focus();
  });
  tabList.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.tab');
    if (!b || renaming) return;
    e.preventDefault();
    const id = b.dataset.tab;
    const last = state.tabs.length === 1;
    openMenu(e, b, `${tabById(id).name} tab`, [
      { label: 'Rename', hint: 'F2', action: () => startRename(id) },
      { label: 'Delete tab', danger: true, disabled: last, hint: last ? 'Last tab' : null, action: () => deleteTab(id) },
    ]);
  });
  $('#tab-add').addEventListener('click', () => {
    const tab = createTab();
    startRename(tab.id);
  });
}

// Drop a dragged tile on a tab to move it there.
export function setupTabDrop() {
  tabList.addEventListener('dragover', (e) => {
    const b = e.target.closest('.tab');
    if (!b || !dragSym || b.dataset.tab === tabOf(dragSym)?.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    for (const t of tabList.querySelectorAll('.drop-target')) if (t !== b) t.classList.remove('drop-target');
    b.classList.add('drop-target');
  });
  tabList.addEventListener('dragleave', (e) => {
    const b = e.target.closest('.tab');
    if (b && !b.contains(e.relatedTarget)) b.classList.remove('drop-target');
  });
  tabList.addEventListener('drop', (e) => {
    const b = e.target.closest('.tab');
    if (!b || !dragSym) return;
    e.preventDefault();
    b.classList.remove('drop-target');
    moveToTab(dragSym, b.dataset.tab);
  });
}
