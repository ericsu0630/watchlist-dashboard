import { $ } from './util.js';
import { state, tiles } from './state.js';
import { chartViewer, handleChartViewerMessage } from './chart-viewer.js';

let ws = null;
let wsRetry = 0;
// After the tab has been hidden this long, nothing is watched until it's visible again.
const HIDDEN_PAUSE_MS = 5 * 60_000;
let paused = false;
let pauseTimer = null;

export function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.addEventListener('open', () => { wsRetry = 0; sendWatch(); });
  ws.addEventListener('message', (e) => handle(JSON.parse(e.data)));
  ws.addEventListener('close', () => {
    setTimeout(connect, Math.min(15000, 600 * 2 ** wsRetry++));
  });
}
export function sendWatch() {
  if (ws?.readyState !== WebSocket.OPEN) {
    return;
  }
  const watch = { type: 'watch', symbols: paused ? [] : state.symbols, tf: state.tf };
  if (!paused && chartViewer.dialog.open && chartViewer.tf !== state.tf) {
    watch.viewer = { symbol: chartViewer.tile.symbol, tf: chartViewer.tf };
  }
  ws.send(JSON.stringify(watch));
}
function onVisibilityChange() {
  clearTimeout(pauseTimer);
  pauseTimer = null;
  if (document.hidden) {
    pauseTimer = setTimeout(() => {
      paused = true;
      sendWatch();
    }, HIDDEN_PAUSE_MS);
    return;
  }
  if (paused) {
    paused = false;
    sendWatch();
  }
}
function handle(msg) {
  const tile = tiles.get(msg.symbol);
  switch (msg.type) {
    case 'hello':
      $('#demo-note').hidden = !msg.demo;
      break;
    case 'bars':
      if (tile && msg.tf === state.tf) tile.setBars(msg.bars, msg.full);
      break;
    case 'info':
      tile?.setInfo(msg.info);
      break;
    case 'quote':
      tile?.setQuote(msg.quote);
      break;
    case 'error':
      if (tile && (!msg.tf || msg.tf === state.tf)) tile.setError(msg.message);
      break;
    case 'retrying':
      if (tile && msg.tf === state.tf && !tile.el.classList.contains('ready')) tile.ui.state.textContent = msg.message;
      break;
  }
  handleChartViewerMessage(msg);
}

export function setupLive() {
  document.addEventListener('visibilitychange', onVisibilityChange);
  if (document.hidden) {
    onVisibilityChange();
  }
}
