/* A ```data-card block renders as a compact metric card: a title with an optional
   badge, a unit line, a grid of labelled numbers, and a footnote.

   Parsing and validation live here so the drawing code only ever receives values
   that already passed the checks. Nothing here executes model text: the body is
   JSON, and every field is re-created through DOM APIs with text content. */
(() => {
  'use strict';

  const LIMITS = { title: 200, label: 60, unit: 16, badge: 40, note: 500 };
  const MAX_ITEMS = 12;

  function text(value, limit) {
    if (value === undefined || value === null) return '';
    const flat = String(value).replace(/\s+/g, ' ').trim();
    return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
  }

  function fail(error) { return { ok: false, error }; }

  function number(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
  }

  /** Trim the float noise a model leaves behind: 8.9100000001 → 8.91. */
  function formatValue(value) {
    if (!Number.isFinite(value)) return '—';
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toFixed(4))).replace(/\.?0+$/, '') || '0';
  }

  function parseDataCard(source) {
    const body = String(source || '').trim();
    if (!body) return fail('卡片内容为空');
    let raw;
    try {
      raw = JSON.parse(body);
    } catch (error) {
      // Mid-stream bodies stop mid-value all the time; that is not an error.
      const message = String(error && error.message ? error.message : '');
      if (/unterminated|unexpected end|end of json/i.test(message) || !/\}\s*$/.test(body)) {
        return { ok: false, incomplete: true, error: '卡片数据尚未输出完整' };
      }
      return fail('卡片 JSON 解析失败：' + text(message, 120));
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('卡片必须是一个 JSON 对象');

    const title = text(raw.title, LIMITS.title);
    if (!title) return fail('缺少 title（卡片标题）');

    const items = Array.isArray(raw.items) ? raw.items : null;
    if (!items || !items.length) return fail('缺少 items（数据项）');
    if (items.length > MAX_ITEMS) return fail(`数据项过多（${items.length} > ${MAX_ITEMS}）`);

    const normalized = [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return fail('items 里存在非对象项');
      const label = text(item.label, LIMITS.label);
      if (!label) return fail('数据项缺少 label');
      const value = number(item.value);
      if (value === null) return fail(`数据项「${label}」的 value 不是数值`);
      const tone = item.tone === 'up' || item.tone === 'down' ? item.tone : '';
      normalized.push({ label, value, unit: text(item.unit, LIMITS.unit), tone });
    }

    return {
      ok: true,
      spec: {
        title,
        unit: text(raw.unit, LIMITS.unit),
        badge: text(raw.badge, LIMITS.badge),
        note: text(raw.note, LIMITS.note),
        items: normalized,
      },
    };
  }

  function el(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function buildDataCard(spec) {
    const card = el('figure', 'data-card');

    const head = el('figcaption', 'data-card-head');
    head.appendChild(el('span', 'data-card-title', spec.title));
    if (spec.badge) head.appendChild(el('span', 'data-card-badge', spec.badge));
    card.appendChild(head);

    if (spec.unit) card.appendChild(el('p', 'data-card-unit', '单位：' + spec.unit));

    const grid = el('div', 'data-card-grid');
    for (const item of spec.items) {
      const cell = el('div', 'data-card-item');
      cell.appendChild(el('span', 'data-card-label', item.label));
      const value = el('b', 'data-card-value' + (item.tone ? ' is-' + item.tone : ''), formatValue(item.value));
      if (item.unit) {
        // The unit rides next to the number so a mixed-unit card still reads.
        const suffix = el('span', 'data-card-suffix', item.unit);
        value.appendChild(suffix);
      }
      cell.appendChild(value);
      grid.appendChild(cell);
    }
    card.appendChild(grid);

    if (spec.note) card.appendChild(el('p', 'data-card-note', spec.note));
    card.dataset.dataCard = '1';
    // Marks this node as the stand-in for the <pre> it replaced, so the next
    // streaming delta keeps it instead of rebuilding it.
    card.dataset.iexaCard = '1';
    return card;
  }

  /**
   * Replace every ```data-card block inside root with a metric card.
   * Safe to call repeatedly: an enhanced block is skipped, and a block that
   * fails validation keeps its text plus one readable banner.
   */
  function enhance(rootEl) {
    if (!rootEl) return 0;
    let rendered = 0;
    rootEl.querySelectorAll('pre > code.language-data-card').forEach((codeEl) => {
      const pre = codeEl.parentElement;
      if (!pre || pre.dataset.dataCardEnhanced) return;

      // A spec is always an object, so a body that does not close cannot be done.
      const raw = codeEl.textContent || '';
      if (!/\}\s*$/.test(raw)) return;

      const result = parseDataCard(raw);
      if (!result.ok) {
        if (result.incomplete) return;
        pre.dataset.dataCardEnhanced = '1';
        const banner = el('div', 'chart-error');
        banner.setAttribute('role', 'note');
        banner.appendChild(el('strong', null, '数据卡片无法显示'));
        banner.appendChild(el('span', null, result.error));
        pre.parentNode.insertBefore(banner, pre);
        return;
      }
      pre.dataset.dataCardEnhanced = '1';
      const card = buildDataCard(result.spec);
      const target = pre.closest('.code-block-wrapper') || pre;
      target.parentNode.insertBefore(card, target);
      target.remove();
      rendered += 1;
    });
    return rendered;
  }

  window.IexaDataCard = Object.freeze({ enhance, buildDataCard, parseDataCard, formatValue });
})();
