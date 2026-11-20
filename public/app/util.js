// Small helpers used across the page.

export const $ = (sel, root = document) => root.querySelector(sel);
export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export const splitSymbol = (id) => { const i = id.indexOf(':'); return [id.slice(0, i), id.slice(i + 1)]; };
export const ticker = (sym) => splitSymbol(sym)[1];

export function decimalsFor(pricescale, price) {
  if (pricescale > 0) return Math.max(0, Math.round(Math.log10(pricescale)));
  if (price == null) return 2;
  return Math.abs(price) < 1 ? 4 : 2;
}
const numberFormats = new Map(); // decimal count -> Intl.NumberFormat
export function fmt(n, d) {
  let nf = numberFormats.get(d);
  if (!nf) {
    nf = new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    numberFormats.set(d, nf);
  }
  return nf.format(Number(n));
}
// DOM writes only when the value actually changes (quotes arrive every second).
export function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
export function setAttr(el, name, value) { if (el.getAttribute(name) !== value) el.setAttribute(name, value); }

const announcer = $('#announce');
export function announce(text) { announcer.textContent = ''; requestAnimationFrame(() => { announcer.textContent = text; }); }

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const stripTags = (s) => s.replace(/<[^>]*>/g, '');
