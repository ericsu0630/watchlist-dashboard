// Shared by the server and the browser.
// Each button sets the candle interval: 1W means every candle is one week.
// interval: TradingView resolution. count: candles loaded (history you can pan back through).
export const TIMEFRAMES = [
  { id: '1h',  label: '1H', interval: '60',  count: 300, hint: 'Hourly candles' },
  { id: '4h',  label: '4H', interval: '240', count: 300, hint: '4-hour candles' },
  { id: '1d',  label: '1D', interval: 'D',   count: 300, hint: 'Daily candles' },
  { id: '1w',  label: '1W', interval: 'W',   count: 300, hint: 'Weekly candles' },
  { id: '1mo', label: '1M', interval: 'M',   count: 300, hint: 'Monthly candles' },
  { id: '3mo', label: '3M', interval: '3M',  count: 200, hint: 'Quarterly candles' },
];
export const DEFAULT_TIMEFRAME = '1d';
