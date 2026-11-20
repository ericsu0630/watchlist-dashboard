import { $, reducedMotion } from './util.js';
import { state, grid } from './state.js';
import { menu, confirmEl } from './menu.js';
import { renaming, switchTab } from './tabs.js';
import { news } from './news.js';

// ------------------------------------------------------------ Keyboard shortcuts (main screen)
// ← → switch tabs; ↑ ↓ scroll the open tab one row of tiles at a time, each row lining up under the top bar.
// Arrow keys keep their usual job wherever they already have one: typing fields and the slider, the
// interval switch and tab list (their own arrow handling runs first), a tile's grip (reorders), menus
// and the delete dialog. Off in the News view.
let rowScroll = null; // { y, at }: target of the last row step, so quick repeats keep stepping
function scrollRows(dir, repeat) {
  const header = $('.bar').offsetHeight;
  const pad = 10; // main's top padding, kept above each row
  const tops = [...new Set([...grid.children].map((el) => Math.round(el.getBoundingClientRect().top + scrollY)))].sort((x, y) => x - y);
  if (!tops.length) return false;
  const base = rowScroll && performance.now() - rowScroll.at < 450 ? rowScroll.y : scrollY;
  const line = base + header + pad; // where the top visible row starts
  const next = dir > 0 ? tops.find((t) => t > line + 4) : [...tops].reverse().find((t) => t < line - 4);
  const max = document.documentElement.scrollHeight - innerHeight;
  const y = Math.max(0, Math.min(max, next != null ? next - header - pad : dir > 0 ? max : 0));
  rowScroll = { y, at: performance.now() };
  scrollTo({ top: y, behavior: repeat || reducedMotion.matches ? 'auto' : 'smooth' });
  return true;
}

export function setupKeys() {
  document.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (news.open || !menu.hidden || confirmEl.open || renaming) return;
    const el = document.activeElement;
    if (el && (el.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || el.closest('#menu, dialog'))) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (state.tabs.length < 2) return;
      e.preventDefault();
      const i = state.tabs.findIndex((t) => t.id === state.activeTab);
      const j = (i + (e.key === 'ArrowRight' ? 1 : -1) + state.tabs.length) % state.tabs.length;
      switchTab(state.tabs[j].id);
    } else if (scrollRows(e.key === 'ArrowDown' ? 1 : -1, e.repeat)) {
      e.preventDefault();
    }
  });
}
