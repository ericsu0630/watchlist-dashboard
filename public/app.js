import { state, tiles } from './app/state.js';
import { CHART_FONT } from './app/theme.js';
import { render, setupBoard } from './app/board.js';
import { setupChartViewer } from './app/chart-viewer.js';
import { setupSort } from './app/sort.js';
import { setupTabs, setupTabDrop } from './app/tabs.js';
import { setupImportExport } from './app/import-export.js';
import { setupKeys } from './app/keys.js';
import { setupMenu } from './app/menu.js';
import { setupTimeframe } from './app/timeframe.js';
import { setupZoom } from './app/zoom.js';
import { connect, setupLive } from './app/live.js';
import { setupSearch } from './app/search.js';
import { setupChips } from './app/chips.js';
import { openNews, setupNews } from './app/news.js';

// Each part registers its own listeners here, in the order the page has always used.
setupChartViewer();
setupSort();
setupTabs();
setupImportExport();
setupTabDrop();
setupBoard();
setupKeys();
setupMenu();
setupTimeframe();
setupZoom();
setupLive();
setupSearch();
setupChips();
setupNews();

// ------------------------------------------------------------ Go
if (new URLSearchParams(location.search).has('debug')) window.__watchlist = { tiles, state }; // for tests
render();
if (location.hash === '#news') openNews({ push: false });
connect();
// Charts draw text on canvas, which doesn't re-render when a web font arrives; nudge them once fonts are in.
document.fonts?.ready.then(() => { for (const t of tiles.values()) t.chart?.applyOptions({ layout: { fontFamily: CHART_FONT } }); });
