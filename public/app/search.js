import { $, escapeHtml, stripTags } from './util.js';
import { isSymbol } from '../symbols.js';
import { tabOf } from './state.js';
import { addSymbol } from './board.js';

const input = $('#search-input');
const list = $('#search-results');
let results = [];
let active = -1;
let searchSeq = 0;
let debounce;

async function runSearch(q) {
  const seq = ++searchSeq;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (seq !== searchSeq) return;
    if (!res.ok) throw new Error(data.error);
    results = data;
    active = results.length ? 0 : -1;
    drawResults(q);
  } catch (err) {
    if (seq !== searchSeq) return;
    results = [];
    list.innerHTML = `<li class="r-note">${escapeHtml(err.message || 'Search is unavailable right now.')}</li>`;
    openResults();
  }
}
function drawResults(q) {
  if (!results.length) {
    list.innerHTML = `<li class="r-note">No symbols match “${escapeHtml(q)}”. Try the company name, or type EXCHANGE:SYMBOL and press Enter.</li>`;
  } else {
    list.innerHTML = results.map((r, i) => `
      <li role="option" id="opt-${i}" data-i="${i}" aria-selected="${i === active}"${tabOf(r.id) ? ' class="added"' : ''}>
        <span class="r-sym">${escapeHtml(r.symbol)}</span>
        <span class="r-desc">${escapeHtml(stripTags(r.description || ''))}</span>
        <span class="r-tag"><b>${escapeHtml(r.exchange || '')}</b> ${escapeHtml(r.type || '')}${tabOf(r.id) ? `<span class="r-in">In ${escapeHtml(tabOf(r.id).name)}</span>` : ''}</span>
      </li>`).join('');
  }
  openResults();
}
function move(d) {
  if (!results.length) return;
  active = (active + d + results.length) % results.length;
  for (const li of list.querySelectorAll('li[data-i]')) li.setAttribute('aria-selected', String(Number(li.dataset.i) === active));
  input.setAttribute('aria-activedescendant', `opt-${active}`);
  list.querySelector(`#opt-${active}`)?.scrollIntoView({ block: 'nearest' });
}
function choose(id) {
  input.value = '';
  closeResults();
  addSymbol(id);
}
function openResults() { list.hidden = false; input.setAttribute('aria-expanded', 'true'); }
function closeResults() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }

export function setupSearch() {
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (!q) return closeResults();
    debounce = setTimeout(() => runSearch(q), 160);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[active] || results[0];
      const typed = input.value.trim().toUpperCase();
      if (pick) choose(pick.id);
      else if (isSymbol(typed)) choose(typed); // Exact EXCHANGE:SYMBOL
    } else if (e.key === 'Escape') { input.value = ''; closeResults(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(closeResults, 120));
  input.addEventListener('focus', () => { if (input.value.trim() && results.length) openResults(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input && !e.metaKey && !e.ctrlKey) { e.preventDefault(); input.focus(); input.select(); }
  });
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    e.preventDefault();
    choose(results[Number(li.dataset.i)].id);
  });
}
