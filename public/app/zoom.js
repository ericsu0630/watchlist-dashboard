import { $ } from './util.js';
import { state, clampZoom, ZOOM_DEFAULT, tiles, save } from './state.js';

const zoomInput = $('#zoom-input');
const zoomValue = $('#zoom-value');
function showZoom() {
  zoomValue.textContent = `${state.zoom}px`;
  zoomInput.setAttribute('aria-valuetext', `${state.zoom} pixel${state.zoom === 1 ? '' : 's'} per candle`);
}

// Sets the candle width from elsewhere (import): slider, label and every chart follow.
export function setZoom(px) {
  const z = clampZoom(px);
  if (z === state.zoom) return;
  state.zoom = z;
  zoomInput.value = z;
  showZoom();
  for (const tile of tiles.values()) tile.fitRange();
  save();
}

export function setupZoom() {
  zoomInput.value = state.zoom;
  showZoom();
  zoomInput.addEventListener('input', () => {
    state.zoom = clampZoom(zoomInput.value);
    showZoom();
    for (const tile of tiles.values()) tile.fitRange();
  });
  zoomInput.addEventListener('change', save);
  zoomInput.addEventListener('dblclick', () => {
    zoomInput.value = ZOOM_DEFAULT;
    zoomInput.dispatchEvent(new Event('input'));
    save();
  });
}
