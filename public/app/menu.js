import { $ } from './util.js';

// ------------------------------------------------------------ Menu and confirmation
// One menu element, filled for whatever was right-clicked. Arrow keys, Home/End, Enter and Esc work as usual.
export const menu = $('#menu');
let menuReturnFocus = null;
let menuToggle = null; // a button that opened the menu and closes it again when clicked
// `toggle` names a menu that belongs to a button (like Sort); clicking that button again closes it.
export function openMenu(e, anchor, label, items, toggle = null) {
  menu.replaceChildren();
  menu.setAttribute('aria-label', label);
  menu.dataset.for = toggle || '';
  menuToggle = toggle ? anchor : null;
  menuToggle?.setAttribute('aria-expanded', 'true');
  for (const item of items) {
    if (item.separator) { const hr = document.createElement('div'); hr.className = 'menu-sep'; hr.role = 'separator'; menu.append(hr); continue; }
    if (item.heading) { const h = document.createElement('div'); h.className = 'menu-heading'; h.role = 'presentation'; h.textContent = item.heading; menu.append(h); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    b.role = item.checked != null ? 'menuitemradio' : 'menuitem';
    if (item.checked != null) b.setAttribute('aria-checked', String(item.checked));
    b.tabIndex = -1;
    b.className = `menu-item${item.danger ? ' danger' : ''}${item.checked != null ? ' radio' : ''}`;
    if (item.disabled) b.setAttribute('aria-disabled', 'true');
    const l = document.createElement('span'); l.textContent = item.label; b.append(l);
    if (item.hint) { const h = document.createElement('span'); h.className = 'menu-hint'; h.textContent = item.hint; b.append(h); }
    b.addEventListener('click', () => {
      if (item.disabled) return;
      const back = menuReturnFocus;
      closeMenu(false);
      item.action();
      // Unless the action moved focus somewhere useful, go back to where the menu was opened from.
      if (back?.isConnected && (!document.activeElement || document.activeElement === document.body || menu.contains(document.activeElement))) back.focus();
    });
    menu.append(b);
  }
  menuReturnFocus = document.activeElement;
  menu.hidden = false;
  // At the pointer; from the keyboard (no pointer position), under the item it belongs to.
  const fromKeyboard = e.button !== 2 && !e.clientX && !e.clientY;
  const r = anchor.getBoundingClientRect();
  let x = fromKeyboard ? r.left + 8 : e.clientX, y = fromKeyboard ? r.bottom + 4 : e.clientY;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  y = y + h > innerHeight - 8 ? Math.max(8, y - h) : y;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const usable = menuItems().filter((b) => !b.hasAttribute('aria-disabled'));
  (usable.find((b) => b.getAttribute('aria-checked') === 'true') || usable[0])?.focus();
}
const menuItems = () => [...menu.querySelectorAll('.menu-item')];
export function closeMenu(restoreFocus = true) {
  if (menu.hidden) return;
  menu.hidden = true;
  menuToggle?.setAttribute('aria-expanded', 'false');
  menuToggle = null;
  if (restoreFocus && menuReturnFocus?.isConnected) menuReturnFocus.focus();
  menuReturnFocus = null;
}

export const confirmEl = $('#confirm');
// A dialog with a choice of buttons ({ value, label, danger, id }); resolves to the chosen value, or
// 'cancel' (Esc). Focus starts on the first button, which should be the safe one.
export function choiceDialog({ title, body, choices }) {
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  $('#confirm-actions').replaceChildren(...choices.map((c) => {
    const b = document.createElement('button');
    b.type = 'submit';
    b.value = c.value;
    b.textContent = c.label;
    if (c.danger) b.className = 'danger';
    if (c.id) b.id = c.id;
    return b;
  }));
  confirmEl.returnValue = '';
  confirmEl.showModal();
  $('#confirm-actions button').focus(); // the safe choice, so a stray Enter doesn't do anything drastic
  return new Promise((resolve) => confirmEl.addEventListener('close', () => resolve(confirmEl.returnValue || 'cancel'), { once: true }));
}
export function confirmDialog({ title, body, ok }) {
  return choiceDialog({ title, body, choices: [{ value: 'cancel', label: 'Cancel' }, { value: 'ok', label: ok, danger: true, id: 'confirm-ok' }] })
    .then((v) => v === 'ok');
}

export function setupMenu() {
  menu.addEventListener('keydown', (e) => {
    const items = menuItems().filter((b) => !b.hasAttribute('aria-disabled'));
    const i = items.indexOf(document.activeElement);
    let j = null;
    if (e.key === 'ArrowDown') j = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(); return; }
    if (j == null) return;
    e.preventDefault();
    items[j]?.focus();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !menuToggle?.contains(e.target)) closeMenu(false);
  }, true);
  addEventListener('blur', () => closeMenu(false));
  addEventListener('resize', () => closeMenu(false));
  addEventListener('scroll', () => closeMenu(false), { passive: true });
}
