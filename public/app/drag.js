import { $ } from './util.js';
import { state, save } from './state.js';
import { render } from './board.js';
import { setSort } from './sort.js';

// ------------------------------------------------------------ Drag to reorder
export let dragSym = null;
export function setupDrag(tile) {
  const el = tile.el;
  const head = $('.tile-head', el);
  // Only the header starts a drag, so chart clicks never reorder a tile.
  head.addEventListener('pointerdown', (e) => { if (!e.target.closest('.remove')) el.draggable = true; });
  el.addEventListener('pointerup', () => { el.draggable = false; });
  el.addEventListener('dragstart', (e) => {
    dragSym = tile.symbol;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tile.symbol);
    requestAnimationFrame(() => el.classList.add('dragging'));
  });
  el.addEventListener('dragend', () => {
    el.draggable = false;
    el.classList.remove('dragging');
    clearDropMarks();
    dragSym = null;
  });
  el.addEventListener('dragover', (e) => {
    if (!dragSym || dragSym === tile.symbol) return;
    e.preventDefault();
    const after = isAfter(e, el);
    clearDropMarks();
    el.classList.add(after ? 'drop-after' : 'drop-before');
  });
  el.addEventListener('drop', (e) => {
    if (!dragSym || dragSym === tile.symbol) return;
    e.preventDefault();
    const after = isAfter(e, el);
    const before = state.symbols.join();
    const from = state.symbols.indexOf(dragSym);
    state.symbols.splice(from, 1);
    let to = state.symbols.indexOf(tile.symbol) + (after ? 1 : 0);
    state.symbols.splice(to, 0, dragSym);
    if (state.symbols.join() !== before) setSort('none'); // the user's own arrangement
    save();
    clearDropMarks();
    render();
  });
}
const isAfter = (e, el) => { const r = el.getBoundingClientRect(); return e.clientX > r.left + r.width / 2; };
const clearDropMarks = () => document.querySelectorAll('.drop-before, .drop-after, .drop-target').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-target'));
