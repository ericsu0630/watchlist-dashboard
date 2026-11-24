const HANDLE_REACH = 7;

function snappedPrice(candles, price) {
  const { minMove, precision } = candles.options().priceFormat;
  return Number((Math.round(price / minMove) * minMove).toFixed(precision));
}

export function suggestPriceLinePrice({ candles }, lines, lastClose) {
  const height = candles.getPane().getHeight();
  const occupied = lines.map(({ price }) => candles.priceToCoordinate(price));
  const candidates = [candles.priceToCoordinate(lastClose), ...[0.35, 0.5, 0.65, 0.2, 0.8].map((fraction) => height * fraction)];
  const y = candidates.find((position) => position != null && position > 8 && position < height - 8
    && occupied.every((coordinate) => coordinate == null || Math.abs(position - coordinate) >= 14));
  return snappedPrice(candles, (y == null ? null : candles.coordinateToPrice(y)) ?? lastClose);
}

export function createPriceLineLayer({ chart, candles }, edit) {
  const { LineStyle } = window.LightweightCharts;
  const rows = [];
  let overlay;
  let drag;

  if (edit) {
    const chartElement = chart.chartElement();
    chartElement.classList.add('editable-price-lines');
    overlay = document.createElement('div');
    overlay.className = 'price-line-handles';
    chartElement.append(overlay);
    const renderer = { draw: positionHandles };
    const paneViews = [{ renderer: () => renderer }];
    candles.attachPrimitive({ paneViews: () => paneViews });
  }

  function positionHandles() {
    const height = candles.getPane().getHeight();
    overlay.style.width = `${chart.timeScale().width()}px`;
    overlay.style.height = `${height}px`;
    const visible = [];
    for (const { line, handle } of rows) {
      const y = candles.priceToCoordinate(line.options().price);
      handle.hidden = !Number.isFinite(y) || y < 0 || y >= height;
      if (!handle.hidden) {
        visible.push({ y, handle });
      }
    }
    visible.sort((a, b) => a.y - b.y);
    for (const [i, { y, handle }] of visible.entries()) {
      const previous = visible[i - 1]?.y ?? -Infinity;
      const next = visible[i + 1]?.y ?? Infinity;
      const top = Math.max(0, y - HANDLE_REACH, (y + previous) / 2);
      const bottom = Math.min(height, y + HANDLE_REACH, (y + next) / 2);
      handle.style.top = `${top}px`;
      handle.style.height = `${bottom - top}px`;
    }
  }

  function addHandle(row) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'price-line-handle';
    handle.hidden = true;
    overlay.append(handle);

    handle.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0 || drag) {
        return;
      }
      event.preventDefault();
      const y = candles.priceToCoordinate(row.price);
      if (y == null) {
        return;
      }
      const offset = event.clientY - overlay.getBoundingClientRect().top - y;
      drag = { row, pointerId: event.pointerId, startY: event.clientY, offset, price: row.price };
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener('pointermove', (event) => {
      if (drag?.row !== row || drag.pointerId !== event.pointerId
        || (!drag.moved && Math.abs(event.clientY - drag.startY) < 4)) {
        return;
      }
      const height = candles.getPane().getHeight();
      const y = event.clientY - overlay.getBoundingClientRect().top - drag.offset;
      const price = candles.coordinateToPrice(Math.max(0, Math.min(y, height - 1)));
      if (price == null) {
        return;
      }
      drag.moved = true;
      drag.price = snappedPrice(candles, price);
      row.line.applyOptions({ price: drag.price });
    });

    function finish(event, commit) {
      if (drag?.row !== row || drag.pointerId !== event.pointerId) {
        return;
      }
      const { price, moved } = drag;
      drag = null;
      if (commit && moved) {
        edit(rows.indexOf(row), price);
      } else if (!commit) {
        row.line.applyOptions({ price: row.price });
      }
    }

    handle.addEventListener('pointerup', (event) => finish(event, true));
    handle.addEventListener('pointercancel', (event) => finish(event, false));
    handle.addEventListener('lostpointercapture', (event) => finish(event, false));
    handle.addEventListener('click', () => edit(rows.indexOf(row)));
    return handle;
  }

  return (levels, selected = -1) => {
    while (rows.length > levels.length) {
      const row = rows.pop();
      if (drag?.row === row) {
        drag = null;
      }
      row.handle?.remove();
      candles.removePriceLine(row.line);
    }
    for (const [i, { price, color }] of levels.entries()) {
      const options = { price, color, lineStyle: i === selected ? LineStyle.Solid : LineStyle.Dashed };
      let row = rows[i];
      if (row) {
        row.line.applyOptions(options);
      } else {
        row = { line: candles.createPriceLine({ ...options, hitTestTolerance: 0 }) };
        if (edit) {
          row.handle = addHandle(row);
        }
        rows.push(row);
      }
      row.price = price;
      if (row.handle) {
        row.handle.setAttribute('aria-label', `Select horizontal line ${i + 1} at ${candles.priceFormatter().format(price)}`);
        row.handle.setAttribute('aria-pressed', String(i === selected));
      }
    }
  };
}
