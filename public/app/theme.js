// Chart colours and font, read from the theme at the top of styles.css.

// Chart colors come from the theme settings at the top of styles.css, so the stylesheet is the one place to change them.
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const COLORS = {
  up: css('--up'), down: css('--down'), text: css('--muted'), grid: css('--chart-grid'),
  cross: css('--crosshair'), label: css('--active'), lastPrice: css('--accent'),
};
// Translucent versions for volume bars and the price tick flash (6-digit hex + alpha).
Object.assign(COLORS, { volUp: `${COLORS.up}2e`, volDown: `${COLORS.down}2e`, flashUp: `${COLORS.up}33`, flashDown: `${COLORS.down}33` });
export const CHART_FONT = "'Barlow Semi Condensed', system-ui, sans-serif";
