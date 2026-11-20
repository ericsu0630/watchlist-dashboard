// Shared by the server and the browser: what a TradingView symbol id looks like (EXCHANGE:SYMBOL).
export const SYMBOL_RE = /^[\w.!&\-]+:[\w.!&\-]+$/;
export const isSymbol = (s) => typeof s === 'string' && SYMBOL_RE.test(s);
