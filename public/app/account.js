import { $, announce } from './util.js';
import { store } from './state.js';
import { choiceDialog } from './menu.js';

// Optional account: a username and password that syncs the board (tabs, symbols, interval, candle width,
// indicator settings) between devices through this server. Signed out, the page works as before, from
// localStorage alone. Signed in, every change is also sent to the server, and other devices pick it up
// when you come back to them. The last change wins.
//
// All saved settings live in localStorage under "pd.*". Sync bookkeeping lives under "pdsync.*" and is
// never sent: user (who this device syncs as), rev (the server version this device has) and dirty
// (changes not yet sent).

const SYNC_PREFIX = 'pd.';
const PUSH_DELAY_MS = 1500;
const POLL_MS = 5_000;

export const account = { user: null, signup: true, status: 'signed-out' }; // status: signed-out | synced | syncing | offline

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
  keys() { try { return Object.keys(localStorage); } catch { return []; } },
};
const localRev = () => Number(ls.get('pdsync.rev')) || 0;

function snapshot() {
  const data = {};
  for (const k of ls.keys().sort()) if (k.startsWith(SYNC_PREFIX)) data[k] = ls.get(k);
  return data;
}
let lastSent = ''; // the snapshot the server is known to have (as a string), so unchanged saves aren't re-sent
let pushTimer = null;
let pushing = false;

async function api(path, { method = 'GET', body, keepalive = false } = {}) {
  const res = await fetch(`/api/account${path}`, {
    method, keepalive, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || 'Request failed.'), { status: res.status });
  return json;
}

function setStatus(status) { account.status = status; }

// ------------------------------------------------------------ Sending changes
function markDirty() {
  ls.set('pdsync.dirty', '1');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, PUSH_DELAY_MS);
}
async function push({ keepalive = false } = {}) {
  clearTimeout(pushTimer);
  if (!account.user || pushing) return;
  const data = snapshot();
  const text = JSON.stringify(data);
  if (text === lastSent) { ls.remove('pdsync.dirty'); return; }
  pushing = true;
  setStatus('syncing');
  try {
    const { rev } = await api('/sync', { method: 'PUT', body: { data }, keepalive });
    lastSent = text;
    ls.set('pdsync.rev', String(rev));
    if (JSON.stringify(snapshot()) === text) ls.remove('pdsync.dirty');
    else markDirty(); // changed again while sending
    setStatus('synced');
  } catch (err) {
    if (err.status === 401) signedOut('Your session ended. Sign in again to keep syncing.');
    else { setStatus('offline'); pushTimer = setTimeout(push, 30_000); }
  } finally {
    pushing = false;
  }
}

// ------------------------------------------------------------ Getting changes
// Replace this device's saved settings with the account's, then reload so the page rebuilds from them.
function applyRemote(remote) {
  for (const k of ls.keys()) if (k.startsWith(SYNC_PREFIX)) ls.remove(k);
  for (const [k, v] of Object.entries(remote.data)) ls.set(k, v);
  ls.set('pdsync.rev', String(remote.rev));
  ls.remove('pdsync.dirty');
  location.reload();
}

// Reloading would interrupt a dialog or someone typing, so a newer board waits for the next check.
const busy = () => !!document.querySelector('dialog[open]') || (document.activeElement?.matches('input, textarea, select') && !!document.activeElement.value);

async function pull() {
  if (!account.user || pushing) return;
  try {
    const remote = await api(`/sync?since=${localRev()}`);
    if (remote.rev > localRev() && remote.data && !ls.get('pdsync.dirty')) {
      if (busy()) return;
      applyRemote(remote);
    } else setStatus('synced');
  } catch (err) {
    if (err.status === 401) signedOut('Your session ended. Sign in again to keep syncing.');
    else setStatus('offline');
  }
}

// First time this device syncs as this account: decide whose board wins.
async function firstSync() {
  const remote = await api('/sync');
  const hasLocal = !!ls.get('pd.tabs');
  if (remote.rev === 0 || !Object.keys(remote.data).length) {
    // New account: it starts with this device's board.
    ls.set('pdsync.user', account.user);
    await push();
    return;
  }
  if (!hasLocal) { ls.set('pdsync.user', account.user); applyRemote(remote); return; }
  const choice = await choiceDialog({
    title: 'Which board do you want to keep?',
    body: `This device already has a board, and so does the account ${account.user}. Pick one; the other is replaced.`,
    choices: [
      { value: 'account', label: 'Use the account’s board' },
      { value: 'device', label: 'Use this device’s board', danger: true },
    ],
  });
  if (choice === 'account') { ls.set('pdsync.user', account.user); applyRemote(remote); }
  else if (choice === 'device') { ls.set('pdsync.user', account.user); await push(); }
  else await signOut(); // cancelled: don't leave a half-synced state
}

export async function syncNow() {
  await push();
  await pull();
}

function signedOut(message) {
  account.user = null;
  setStatus('signed-out');
  for (const k of ls.keys()) if (k.startsWith('pdsync.')) ls.remove(k);
  lastSent = '';
  clearTimeout(pushTimer);
  if (message) announce(message);
}

export async function signOut() {
  try { await api('/logout', { method: 'POST', body: {} }); } catch { /* the server may be unreachable; sign out here anyway */ }
  signedOut('Signed out. Your board stays on this device.');
}

// ------------------------------------------------------------ Sign in dialog
const dialog = $('#account-dialog');
const form = $('#account-form');
const nameInput = $('#account-name');
const passInput = $('#account-pass');
const message = $('#account-message');
const submitBtn = $('#account-submit');
const switchBtn = $('#account-switch');
let creating = false;

function setMode(create) {
  creating = create && account.signup;
  $('#account-title').textContent = creating ? 'Create an account' : 'Sign in';
  $('#account-hint').textContent = creating
    ? 'Your board will sync between devices that use this server. Passwords need at least 8 characters.'
    : 'Sign in to sync your board between devices that use this server.';
  submitBtn.textContent = creating ? 'Create account' : 'Sign in';
  switchBtn.textContent = creating ? 'I already have an account' : 'Create an account';
  switchBtn.hidden = !account.signup;
  passInput.autocomplete = creating ? 'new-password' : 'current-password';
  message.textContent = '';
}

export function openAccountDialog() {
  form.reset();
  setMode(false);
  dialog.showModal();
  nameInput.focus();
}

async function submitAccount(e) {
  e.preventDefault();
  submitBtn.disabled = true;
  message.textContent = '';
  try {
    const { user } = await api(creating ? '/signup' : '/login', { method: 'POST', body: { username: nameInput.value.trim(), password: passInput.value } });
    account.user = user;
    dialog.close();
    form.reset();
    setStatus('syncing');
    await firstSync();
    if (account.user) { setStatus('synced'); announce(`Signed in as ${user}. Your board syncs now.`); }
  } catch (err) {
    message.textContent = err.message;
    passInput.select();
  } finally {
    submitBtn.disabled = false;
  }
}

// ------------------------------------------------------------ Start
export async function setupAccount() {
  form.addEventListener('submit', submitAccount);
  switchBtn.addEventListener('click', () => { setMode(!creating); nameInput.focus(); });
  $('#account-cancel').addEventListener('click', () => dialog.close());

  // The saves while the page loaded are already done, so from here a save is a real change.
  // Everything below does nothing until someone is signed in (account.user).
  store.onSet = (key) => { if (account.user && key.startsWith(SYNC_PREFIX)) markDirty(); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (account.user && ls.get('pdsync.dirty')) push({ keepalive: true }); }
    else pull();
  });
  setInterval(() => { if (document.visibilityState === 'visible') pull(); }, POLL_MS);

  let info;
  try { info = await api(''); } catch { return; } // server unreachable: stay signed out
  account.signup = info.signup;
  if (!info.user) { signedOut(); return; }

  account.user = info.user;
  setStatus('syncing');
  try {
    if (ls.get('pdsync.user') !== info.user) await firstSync();
    else {
      const remote = await api('/sync');
      if (remote.rev > localRev() && !ls.get('pdsync.dirty')) { applyRemote(remote); return; }
      lastSent = JSON.stringify(snapshot());
      if (ls.get('pdsync.dirty')) { lastSent = ''; await push(); } // changes from before the page was closed
    }
    if (!account.user) return; // cancelled in the dialog
    setStatus('synced');
  } catch (err) {
    if (err.status === 401) signedOut();
    else setStatus('offline');
  }

}
