/* Interactive charts for chat messages.

   Integration contract: markdown renders a ```chart fenced block as an ordinary
   <pre><code class="language-chart">, exactly like any other code block, so the
   existing DOMPurify boundary in SafeMarkdown stays untouched. This module runs
   after that render (same place enhanceCodeBlocks/enhanceTables run) and swaps
   the block for a chart built entirely with DOM APIs from validated data.

   No eval, no innerHTML of model text, no remote assets. */
(() => {
  'use strict';

  const WIDTH = 720; // fallback when the container has not been laid out yet
  const PAD = { top: 18, right: 18, bottom: 48, left: 60 };
  const SERIES_SLOTS = 8;

  // One shared observer: a per-chart observer would leak for every message ever
  // rendered. Charts are re-drawn only when the width actually changed.
  const widths = new WeakMap();
  let observer = null;

  function svg(tag, attributes) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attributes) for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Axis ticks on 1/2/2.5/5 × 10^n so labels stay round numbers. */
  function niceTicks(min, max, target = 5) {
    if (!(max > min)) { max = min + 1; }
    const raw = (max - min) / target;
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const normalized = raw / magnitude;
    const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
    const start = Math.floor(min / step) * step;
    const end = Math.ceil(max / step) * step;
    const ticks = [];
    // Guard against a pathological step that would emit thousands of ticks.
    for (let value = start, guard = 0; value <= end + step / 2 && guard < 40; value += step, guard += 1) {
      ticks.push(Math.abs(value) < step / 1e6 ? 0 : value);
    }
    return ticks;
  }

  function formatNumber(value, unit) {
    const absolute = Math.abs(value);
    let body;
    if (absolute >= 1e9) body = (value / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    else if (absolute >= 1e6) body = (value / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    else if (absolute >= 1e4) body = (value / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    else if (Number.isInteger(value)) body = String(value);
    else body = value.toFixed(Math.abs(value) < 1 ? 3 : 1).replace(/\.?0+$/, '');
    return unit ? body + ' ' + unit : body;
  }

  function seriesColor(index) {
    return `var(--chart-c${(index % SERIES_SLOTS) + 1})`;
  }

  // ---- drawing -------------------------------------------------------------

  function drawAxes(root, spec, ticks, plot, height) {
    const { left, top, right, bottom } = plot;
    for (const value of ticks) {
      const y = plot.y(value);
      const line = svg('line', { x1: left, x2: right, y1: y, y2: y, class: 'chart-grid' });
      root.appendChild(line);
      const label = svg('text', { x: left - 10, y: y + 4, class: 'chart-axis-label', 'text-anchor': 'end' });
      label.textContent = formatNumber(value, '');
      root.appendChild(label);
    }
    root.appendChild(svg('line', { x1: left, x2: left, y1: top, y2: bottom, class: 'chart-axis' }));
    root.appendChild(svg('line', { x1: left, x2: right, y1: bottom, y2: bottom, class: 'chart-axis' }));

    if (spec.yLabel) {
      const label = svg('text', { x: 14, y: top + (bottom - top) / 2, class: 'chart-axis-title', 'text-anchor': 'middle', transform: `rotate(-90 14 ${top + (bottom - top) / 2})` });
      label.textContent = spec.yLabel;
      root.appendChild(label);
    }
    if (spec.xLabel) {
      // Inside the viewBox that was actually used, not the module constant: the
      // height is derived from the measured width, so a fixed baseline would
      // land outside the card at any width but the default.
      const label = svg('text', { x: left + (right - left) / 2, y: height - 6, class: 'chart-axis-title', 'text-anchor': 'middle' });
      label.textContent = spec.xLabel;
      root.appendChild(label);
    }
  }

  function drawXLabels(root, spec, plot) {
    const count = spec.categories.length;
    const slot = (plot.right - plot.left) / count;
    // Thin the labels out rather than overlapping them.
    const every = Math.max(1, Math.ceil(count / Math.max(1, Math.floor((plot.right - plot.left) / 68))));
    for (let index = 0; index < count; index += every) {
      const x = plot.left + slot * (index + 0.5);
      const label = svg('text', { x, y: plot.bottom + 17, class: 'chart-axis-label', 'text-anchor': 'middle' });
      label.textContent = spec.categories[index];
      root.appendChild(label);
    }
  }

  function drawLine(root, spec, plot) {
    const count = spec.categories.length;
    const slot = (plot.right - plot.left) / count;
    spec.series.forEach((series, seriesIndex) => {
      const group = svg('g', { class: 'chart-line-group' });
      const color = seriesColor(seriesIndex);
      let run = [];
      const flush = () => {
        if (run.length > 1) {
          const polyline = svg('polyline', { points: run.join(' '), class: 'chart-line', fill: 'none' });
          polyline.style.stroke = color;
          group.appendChild(polyline);
        } else if (run.length === 1) {
          const [x, y] = run[0].split(',');
          const dot = svg('circle', { cx: x, cy: y, r: 2.5, class: 'chart-dot' });
          dot.style.fill = color;
          group.appendChild(dot);
        }
        run = [];
      };
      series.values.forEach((value, index) => {
        if (value === null) { flush(); return; }
        run.push(`${(plot.left + slot * (index + 0.5)).toFixed(1)},${plot.y(value).toFixed(1)}`);
      });
      flush();
      root.appendChild(group);
    });
  }

  function drawBar(root, spec, plot) {
    const count = spec.categories.length;
    const slot = (plot.right - plot.left) / count;
    const seriesCount = spec.series.length;
    const barWidth = Math.max(1.5, (slot * 0.72) / seriesCount);
    const zeroY = plot.y(Math.max(plot.min, Math.min(0, plot.max)));
    spec.series.forEach((series, seriesIndex) => {
      const group = svg('g', { class: 'chart-bar-group' });
      series.values.forEach((value, index) => {
        if (value === null) return;
        const y = plot.y(value);
        const height = Math.abs(y - zeroY);
        const x = plot.left + slot * index + (slot - barWidth * seriesCount) / 2 + barWidth * seriesIndex;
        const rect = svg('rect', {
          x: x.toFixed(2), y: Math.min(y, zeroY).toFixed(2),
          width: barWidth.toFixed(2), height: Math.max(1, height).toFixed(2),
          rx: Math.min(3, barWidth / 3), class: 'chart-bar',
        });
        rect.style.fill = seriesColor(seriesIndex);
        group.appendChild(rect);
      });
      root.appendChild(group);
    });
  }

  function drawChart(body, spec) {
    const host = el('div', 'chart-canvas');
    // Render at the measured width, not a fixed 720: a viewBox wider than the
    // element scales the axis labels down with it, which made 10.5px text
    // unreadable inside a 430px column.
    const width = Math.max(320, Math.round(body.clientWidth || WIDTH));
    const height = Math.max(220, Math.min(420, Math.round(width * 0.42)));
    const root = svg('svg', {
      viewBox: `0 0 ${width} ${height}`, width: '100%', height,
      role: 'img', 'aria-label': spec.title || '图表',
    });
    root.classList.add('chart-svg');

    const plot = {
      left: PAD.left, right: width - PAD.right, top: PAD.top, bottom: height - PAD.bottom,
    };
    const range = window.IexaChartSpec.valueRange(spec);
    const ticks = niceTicks(Math.min(range.min, 0), Math.max(range.max, 0));
    plot.min = ticks[0];
    plot.max = ticks[ticks.length - 1];
    plot.y = (value) => plot.bottom - ((value - plot.min) / (plot.max - plot.min || 1)) * (plot.bottom - plot.top);

    drawAxes(root, spec, ticks, plot, height);
    drawXLabels(root, spec, plot);
    if (spec.type === 'bar') drawBar(root, spec, plot); else drawLine(root, spec, plot);

    // Hover layer: one transparent rect over the plot, a guide line and a tooltip.
    const guide = svg('line', { class: 'chart-guide', y1: plot.top, y2: plot.bottom, x1: 0, x2: 0, visibility: 'hidden' });
    root.appendChild(guide);
    const hit = svg('rect', { x: plot.left, y: plot.top, width: plot.right - plot.left, height: plot.bottom - plot.top, fill: 'transparent' });
    root.appendChild(hit);

    const tip = el('div', 'chart-tooltip');
    tip.hidden = true;
    host.appendChild(root);
    host.appendChild(tip);

    const count = spec.categories.length;
    const slot = (plot.right - plot.left) / count;
    hit.addEventListener('pointermove', (event) => {
      const box = root.getBoundingClientRect();
      // The viewBox is 1:1 with CSS pixels now, but keep the ratio for the
      // fractional layouts where the box is a hair off.
      const scale = box.width ? width / box.width : 1;
      const x = (event.clientX - box.left) * scale;
      const index = Math.max(0, Math.min(count - 1, Math.floor((x - plot.left) / slot)));
      const guideX = plot.left + slot * (index + 0.5);
      guide.setAttribute('x1', String(guideX));
      guide.setAttribute('x2', String(guideX));
      guide.setAttribute('visibility', 'visible');

      tip.replaceChildren();
      tip.appendChild(el('div', 'chart-tooltip-head', spec.categories[index]));
      spec.series.forEach((series, seriesIndex) => {
        const row = el('div', 'chart-tooltip-row');
        const swatch = el('i', 'chart-swatch');
        swatch.style.background = seriesColor(seriesIndex);
        row.appendChild(swatch);
        row.appendChild(el('span', 'chart-tooltip-name', series.name));
        const value = series.values[index];
        row.appendChild(el('b', 'chart-tooltip-value', value === null ? '—' : formatNumber(value, spec.unit)));
        tip.appendChild(row);
      });
      tip.hidden = false;
      // Keep the tooltip inside the canvas instead of letting it run off.
      const left = Math.min(Math.max(0, (guideX / width) * box.width - 60), Math.max(0, box.width - 150));
      tip.style.left = left + 'px';
    });
    hit.addEventListener('pointerleave', () => { tip.hidden = true; guide.setAttribute('visibility', 'hidden'); });

    body.replaceChildren(host);
  }

  function buildTable(spec) {
    const wrapper = el('div', 'chart-table-wrap');
    const table = el('table', 'chart-table');
    const head = el('thead');
    const headRow = el('tr');
    headRow.appendChild(el('th', null, spec.xLabel || '分类'));
    spec.series.forEach((series) => headRow.appendChild(el('th', null, series.name)));
    head.appendChild(headRow);
    table.appendChild(head);
    const bodyEl = el('tbody');
    spec.categories.forEach((category, index) => {
      const row = el('tr');
      row.appendChild(el('th', null, category));
      spec.series.forEach((series) => {
        const value = series.values[index];
        row.appendChild(el('td', null, value === null ? '—' : formatNumber(value, spec.unit)));
      });
      bodyEl.appendChild(row);
    });
    table.appendChild(bodyEl);
    wrapper.appendChild(table);
    return wrapper;
  }

  function buildCard(spec) {
    const card = el('figure', 'chart-card');
    card.dataset.chartType = spec.type;

    const head = el('figcaption', 'chart-head');
    const title = el('span', 'chart-title', spec.title || '图表');
    head.appendChild(title);
    const toggle = el('button', 'chart-toggle');
    toggle.type = 'button';
    toggle.textContent = '表格';
    toggle.setAttribute('aria-pressed', 'false');
    head.appendChild(toggle);
    card.appendChild(head);

    const body = el('div', 'chart-body');
    card.appendChild(body);
    drawChart(body, spec);

    const tableHolder = el('div', 'chart-table-holder');
    tableHolder.hidden = true;
    card.appendChild(tableHolder);

    if (spec.series.length > 1) {
      const legend = el('div', 'chart-legend');
      spec.series.forEach((series, index) => {
        const item = el('span', 'chart-legend-item');
        const swatch = el('i', 'chart-swatch');
        swatch.style.background = seriesColor(index);
        item.appendChild(swatch);
        item.appendChild(el('span', null, series.name));
        legend.appendChild(item);
      });
      card.appendChild(legend);
    }
    if (spec.note) card.appendChild(el('p', 'chart-note', spec.note));

    toggle.addEventListener('click', () => {
      const showingTable = tableHolder.hidden;
      if (showingTable && !tableHolder.childElementCount) tableHolder.appendChild(buildTable(spec));
      tableHolder.hidden = !showingTable;
      body.hidden = showingTable;
      toggle.textContent = showingTable ? '图表' : '表格';
      toggle.setAttribute('aria-pressed', String(showingTable));
    });

    card._chartSpec = spec;
    return card;
  }

  function ensureObserver() {
    if (observer || typeof ResizeObserver !== 'function') return observer;
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const card = entry.target.closest('.chart-card');
        if (!card) continue;
        if (!card.isConnected) { observer.unobserve(entry.target); continue; }
        const width = Math.round(entry.contentRect.width);
        // Re-drawing on every pixel would thrash during a window drag.
        if (Math.abs((widths.get(card) || 0) - width) < 24) continue;
        widths.set(card, width);
        const body = card.querySelector('.chart-body');
        if (body && card._chartSpec) drawChart(body, card._chartSpec);
      }
    });
    return observer;
  }

  /**
   * Replace every ```chart block inside root with a chart card.
   * Safe to call repeatedly: an enhanced block is skipped, and a block that
   * failed validation keeps its original text plus a single error banner.
   */
  function enhance(rootEl) {
    if (!rootEl || !window.IexaChartSpec) return 0;
    let rendered = 0;
    rootEl.querySelectorAll('pre > code.language-chart').forEach((codeEl) => {
      const pre = codeEl.parentElement;
      if (!pre || pre.dataset.chartEnhanced) return;

      // Cheap pre-filter for the streaming path: a spec is always an object, so a
      // body that does not end in `}` cannot be complete. Skipping the parse here
      // avoids re-parsing a growing half-written JSON on every delta.
      const raw = codeEl.textContent || '';
      if (!/\}\s*$/.test(raw)) return;

      const result = window.IexaChartSpec.parseChartSpec(raw);
      if (!result.ok) {
        // Mid-stream bodies stop mid-value all the time. Leave the block alone and
        // do not mark it: the final render will pick it up once the JSON is whole.
        if (result.incomplete) return;
        pre.dataset.chartEnhanced = '1';
        // Keep the raw data readable: an unparseable chart is still information.
        const banner = el('div', 'chart-error');
        banner.setAttribute('role', 'note');
        banner.appendChild(el('strong', null, '图表无法显示'));
        banner.appendChild(el('span', null, result.error));
        pre.parentNode.insertBefore(banner, pre);
        return;
      }
      pre.dataset.chartEnhanced = '1';
      const card = buildCard(result.spec);
      // Tells patch() this node represents the <pre> it replaced, so the next
      // streaming delta keeps it instead of rebuilding the SVG.
      card.dataset.chartCard = '1';
      const target = pre.closest('.code-block-wrapper') || pre;
      target.parentNode.insertBefore(card, target);
      target.remove();
      rendered += 1;
      const watch = ensureObserver();
      if (watch) { widths.set(card, Math.round(card.clientWidth)); watch.observe(card); }
    });
    return rendered;
  }

  window.IexaChart = Object.freeze({ enhance, buildCard, niceTicks, formatNumber });
})();
