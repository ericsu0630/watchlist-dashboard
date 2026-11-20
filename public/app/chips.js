import { $, splitSymbol } from './util.js';
import { addSymbol } from './board.js';

const SUGGESTIONS = ['NASDAQ:AAPL', 'NASDAQ:NVDA', 'NASDAQ:TSLA', 'AMEX:SPY', 'TWSE:2330', 'BINANCE:BTCUSDT', 'FX:EURUSD', 'TVC:GOLD'];

export function setupChips() {
  const chips = $('#chips');
  for (const id of SUGGESTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = splitSymbol(id)[1];
    b.title = id;
    b.addEventListener('click', () => addSymbol(id));
    chips.append(b);
  }
}
