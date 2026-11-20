import { $, setText, escapeHtml, ticker } from './util.js';
import { state, allSymbols, tabById, grid } from './state.js';
import { render } from './board.js';
import { LIVE_SORTS, resortSoon } from './sort.js';

const searchInput = $('#search-input');

// ------------------------------------------------------------ News view
// Replaces the grid with the latest headlines (window set by the server, 24 hours) for every symbol on the board.
const NEWS_REFRESH_MS = 5 * 60_000;
export const news = {
  open: false, data: null, filter: null, seq: 0, loading: false, timer: null, tick: null,
  view: $('#news'), list: $('#news-list'), sub: $('#news-sub'), note: $('#news-note'), filterEl: $('#news-filter'), tabsEl: $('#news-tabs'),
  tabFilter: null, // tab id chosen with the tab buttons, or null for all tabs
  btn: $('#news-btn'), back: $('#news-back'), refresh: $('#news-refresh'),
};

export function openNews({ push = true } = {}) {
  if (news.open) return;
  news.open = true;
  grid.hidden = true; // hidden tiles count as off screen, so their charts are freed while reading
  $('#tabs').hidden = true; // headlines cover every tab
  $('#empty').hidden = true;
  news.view.hidden = false;
  news.btn.setAttribute('aria-expanded', 'true');
  if (push) history.pushState({ view: 'news' }, '', '#news');
  scrollTo(0, 0);
  news.back.focus();
  loadNews();
  news.timer = setInterval(() => loadNews({ fresh: true, background: true }), NEWS_REFRESH_MS);
  news.tick = setInterval(tickNews, 60_000); // keep "x min ago" current
}
function closeNews({ fromHistory = false } = {}) {
  if (!news.open) return;
  if (!fromHistory && history.state?.view === 'news') { history.back(); return; } // popstate closes it
  news.open = false;
  clearInterval(news.timer); clearInterval(news.tick);
  news.view.hidden = true;
  grid.hidden = false;
  $('#tabs').hidden = false;
  news.btn.setAttribute('aria-expanded', 'false');
  if (location.hash === '#news') history.replaceState(null, '', location.pathname);
  render();
  if (LIVE_SORTS.has(state.sort)) resortSoon(800);
  news.btn.focus();
}

// Opening the view takes what the server already has (instant, possibly a few minutes old) and then,
// if the server says newer headlines are on the way, asks again and waits for them (`fresh`).
// The 5-minute refresh and the refresh button always wait for fresh headlines.
export async function loadNews({ fresh = false, background = false } = {}) {
  const seq = ++news.seq;
  const symbols = allSymbols(); // every tab
  if (!symbols.length) { news.data = { items: [], failed: [] }; renderNews(); return; }
  news.loading = true;
  news.refresh.classList.add('spinning');
  // Dim the list only when the user asked for new headlines; a background update leaves it readable.
  news.list.classList.toggle('refreshing', !!news.data && !background);
  if (!news.data) news.list.innerHTML = '<div class="news-state"><p>Loading headlines…</p></div>';
  let again = false;
  try {
    const res = await fetch(`/api/news?symbols=${encodeURIComponent(symbols.join(','))}${fresh ? '&fresh=1' : ''}`);
    const data = await res.json();
    if (seq !== news.seq) return;
    if (!res.ok) throw new Error(data.error || 'Headlines are unavailable right now.');
    news.data = data;
    again = data.refreshing && !fresh;
  } catch (err) {
    if (seq !== news.seq) return;
    // A failed background update keeps the headlines already on screen.
    if (!(background && news.data && !news.data.error)) news.data = { error: err.message || 'Headlines are unavailable right now.' };
  } finally {
    if (seq === news.seq) {
      news.loading = false;
      news.refresh.classList.remove('spinning');
      news.list.classList.remove('refreshing');
      renderNews();
    }
  }
  if (again && seq === news.seq && news.open) loadNews({ fresh: true, background: true });
}

// Ask the server to start fetching headlines before the News view is opened, so it opens instantly.
let lastWarm = { key: '', at: 0 };
export function warmNews() {
  const key = allSymbols().join(',');
  if (!key || (key === lastWarm.key && Date.now() - lastWarm.at < 60_000)) return;
  lastWarm = { key, at: Date.now() };
  fetch(`/api/news/warm?symbols=${encodeURIComponent(key)}`, { method: 'POST' }).catch(() => {});
}

function timeAgo(t) {
  const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60));
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}
function dayLabel(t) {
  const d = new Date(t * 1000), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
const clock = (t) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

// Updates the "x min ago" labels in place, so focus and hover aren't disturbed.
// After midnight "Today" and "Yesterday" headings are out of date, so the list is rebuilt then.
function tickNews() {
  if (!news.open) return;
  if (new Date().toDateString() !== news.renderedDay) { renderNews(); return; }
  for (const el of news.list.querySelectorAll('.ago')) setText(el, timeAgo(Number(el.dataset.t)));
}

// Identifies a focusable element in the news view across a rebuild of its HTML.
function newsFocusKey(el) {
  const part = el.dataset.tabfilter != null ? `t:${el.dataset.tabfilter}`
    : el.dataset.filter != null ? `f:${el.dataset.filter}`
    : el.classList.contains('story-title') ? 't'
    : el.hasAttribute('data-retry') ? 'r' : null;
  return part && `${el.closest('.story')?.dataset.id ?? ''}|${part}`;
}

function renderNews() {
  if (!news.open) return;
  // Rebuilding replaces the elements: remember what had keyboard focus and put it back afterwards.
  const focused = news.view.contains(document.activeElement) ? newsFocusKey(document.activeElement) : null;
  drawNews();
  news.renderedDay = new Date().toDateString();
  if (focused) {
    for (const el of news.view.querySelectorAll('[data-tabfilter], [data-filter], .story-title, [data-retry]')) {
      if (newsFocusKey(el) === focused) { el.focus({ preventScroll: true }); break; }
    }
  }
}

function drawNews() {
  const d = news.data;
  const symbols = allSymbols(); // headlines cover every tab
  const n = symbols.length;
  if (!d) return;
  if (d.error) {
    news.sub.textContent = '';
    news.filterEl.replaceChildren();
    news.tabsEl.hidden = true;
    news.note.hidden = true;
    news.list.innerHTML = `<div class="news-state"><p>${escapeHtml(d.error)} Check your internet connection.</p><button type="button" data-retry>Try again</button></div>`;
    return;
  }
  const items = d.items || [];
  // Filters for a tab or symbol that's no longer on the board are dropped.
  if (news.tabFilter && !tabById(news.tabFilter)) news.tabFilter = null;
  if (news.filter && !symbols.includes(news.filter)) news.filter = null;
  // A tab shows the stories that mention any of its symbols; a symbol, the stories that mention it.
  const tabSet = (t) => new Set(t.symbols);
  const inSet = (set) => (it) => it.symbols.some((s) => set.has(s));
  const tabFilter = news.tabFilter ? tabById(news.tabFilter) : null;
  const shown = news.filter ? items.filter((it) => it.symbols.includes(news.filter))
    : tabFilter ? items.filter(inSet(tabSet(tabFilter))) : items;

  const win = `${d.windowHours || 24} hours`;
  const updated = d.refreshing ? ' Checking for newer headlines…' : d.fetchedAt ? ` Updated ${clock(d.fetchedAt)}.` : '';
  const recentN = items.filter((it) => !it.older).length;
  const olderN = items.length - recentN;
  const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  news.sub.textContent = n
    ? `${plural(recentN, 'headline')} from the last ${win} for your ${plural(n, 'symbol')}${olderN ? `, plus ${olderN} earlier for quiet ones` : ''}.${updated}`
    : '';

  // Tab buttons (All, then each tab with its headline count), shown when there's more than one tab.
  const tabBtn = (id, label, count) =>
    `<button type="button" data-tabfilter="${escapeHtml(id)}" aria-pressed="${(news.tabFilter || '') === id}">${escapeHtml(label)} <span>${count}</span></button>`;
  news.tabsEl.hidden = state.tabs.length < 2 || !n;
  news.tabsEl.innerHTML = news.tabsEl.hidden ? ''
    : tabBtn('', 'All', items.length) + state.tabs.map((t) => tabBtn(t.id, t.name, items.filter(inSet(tabSet(t))).length)).join('');
  // Symbol chips: the chosen tab's symbols (or every symbol), with their headline counts, in board order.
  // Clicking one shows only its headlines; clicking it again goes back.
  const counts = new Map(symbols.map((s) => [s, 0]));
  for (const it of items) for (const s of it.symbols) counts.set(s, (counts.get(s) || 0) + 1);
  const chip = (sym) =>
    `<button type="button" data-filter="${escapeHtml(sym)}" aria-pressed="${news.filter === sym}">${escapeHtml(ticker(sym))} <span>${counts.get(sym) || 0}</span></button>`;
  news.filterEl.innerHTML = n ? (tabFilter ? tabFilter.symbols : symbols).map(chip).join('') : '';

  const failed = (d.failed || []).filter((s) => symbols.includes(s));
  news.note.hidden = !failed.length;
  if (failed.length) news.note.textContent = `Headlines for ${failed.map(ticker).join(', ')} couldn't be loaded. They'll be retried on the next refresh.`;

  if (!n) {
    news.list.innerHTML = '<div class="news-state"><p>Add a symbol with the search bar to see its headlines here.</p></div>';
    return;
  }
  if (!shown.length) {
    const msg = failed.length === n ? 'Headlines couldn\'t be loaded for any of your symbols.'
      : news.filter ? `No headlines for ${escapeHtml(ticker(news.filter))} in the last ${win}.`
      : tabFilter ? `No headlines for the symbols in ${escapeHtml(tabFilter.name)} in the last ${win}.` : `No headlines for your symbols in the last ${win}.`;
    news.list.innerHTML = `<div class="news-state"><p>${msg}</p>${failed.length === n ? '<button type="button" data-retry>Try again</button>' : ''}</div>`;
    return;
  }
  let html = '', lastDay = '', inOlder = false;
  for (const it of shown) {
    if (it.older && !inOlder) {
      // Quiet symbols: their latest stories from before the window, in their own section.
      inOlder = true; lastDay = '';
      const quiet = (d.olderFor || []).filter((s) => (news.filter ? s === news.filter : !tabFilter || tabFilter.symbols.includes(s))).map(ticker);
      html += `<section class="news-older"><h2>Earlier headlines</h2><p>No news in the last ${win} for ${escapeHtml(quiet.join(', ') || 'this symbol')}, so here are the latest stories from the past two weeks.</p></section>`;
    }
    const day = dayLabel(it.published);
    if (day !== lastDay) { html += `<h2 class="news-day">${escapeHtml(day)}</h2>`; lastDay = day; }
    const lang = it.lang ? ` lang="${escapeHtml(it.lang)}"` : '';
    const title = it.url
      ? `<a class="story-title" href="${escapeHtml(it.url)}" target="_blank" rel="noopener noreferrer"${lang}>${escapeHtml(it.title)}</a>`
      : `<span class="story-title"${lang}>${escapeHtml(it.title)}</span>`;
    const chips = it.symbols.map((s) => `<button type="button" data-filter="${escapeHtml(s)}" title="Show only ${escapeHtml(ticker(s))} headlines">${escapeHtml(ticker(s))}</button>`).join('');
    html += `<article class="story" data-id="${escapeHtml(it.id)}"><time datetime="${new Date(it.published * 1000).toISOString()}">${clock(it.published)}</time><div>${title}
      <div class="story-meta">${it.source ? `<span>${escapeHtml(it.source)}</span>` : ''}<span class="ago" data-t="${it.published}">${timeAgo(it.published)}</span>${chips}</div></div></article>`;
  }
  news.list.innerHTML = html;
}

export function setupNews() {
  news.btn.addEventListener('click', () => (news.open ? closeNews() : openNews()));
  news.back.addEventListener('click', () => closeNews());
  news.refresh.addEventListener('click', () => loadNews({ fresh: true }));
  addEventListener('popstate', () => (location.hash === '#news' ? openNews({ push: false }) : closeNews({ fromHistory: true })));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && news.open && document.activeElement !== searchInput) closeNews();
  });
  setTimeout(warmNews, 3000); // after the charts have had their turn
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') warmNews(); });
  news.btn.addEventListener('pointerenter', warmNews);
  // Filter chips (top row and on each story) and retry buttons.
  news.view.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tabfilter]');
    if (t) {
      news.tabFilter = t.dataset.tabfilter || null;
      news.filter = null;
      renderNews();
      return;
    }
    const f = e.target.closest('[data-filter]');
    if (f) {
      const sym = f.dataset.filter;
      news.filter = news.filter === sym ? null : sym;
      // A symbol from outside the chosen tab (a story can mention several) widens the tab choice to All.
      if (news.filter && news.tabFilter && !tabById(news.tabFilter)?.symbols.includes(sym)) news.tabFilter = null;
      renderNews();
      return;
    }
    if (e.target.closest('[data-retry]')) loadNews();
  });
}
