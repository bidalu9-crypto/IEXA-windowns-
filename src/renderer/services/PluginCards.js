/* Shared immutable tool-result presentation; also used to restore saved sessions. */
(() => {
  'use strict';
  const make = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  function render(presentation, options = {}) {
    const card = presentation?.card;
    if (!card || card.version !== 1 || typeof card.title !== 'string' || typeof presentation.pluginId !== 'string') return null;
    const root = make('section', 'plugin-result-card');
    root.setAttribute('aria-label', card.title.slice(0, 160));
    const head = make('header', 'plugin-result-head');
    const label = make('div', 'plugin-result-identity');
    label.append(make('small', '', String(presentation.pluginName || presentation.pluginId).slice(0, 80)), make('strong', '', card.title.slice(0, 160))); head.append(label);
    if (options.openPanel !== false) {
      const open = make('button', 'tool-toggle-params', '打开拓展'); open.type = 'button';
      open.addEventListener('click', () => window.dispatchEvent(new CustomEvent('iexa:open-plugin', { detail: { id: presentation.pluginId } })));
      head.append(open);
    }
    root.append(head);
    if (typeof card.description === 'string') root.append(make('p', 'plugin-result-description', card.description.slice(0, 2000)));
    if (Array.isArray(card.fields)) {
      const fields = make('dl', 'plugin-result-fields');
      for (const field of card.fields.slice(0, 24)) if (field && typeof field.label === 'string' && typeof field.value === 'string') {
        const pair = make('div', ''); pair.append(make('dt', '', field.label.slice(0, 100)), make('dd', '', field.value.slice(0, 2000))); fields.append(pair);
      }
      root.append(fields);
    }
    if (Array.isArray(card.table?.columns) && Array.isArray(card.table?.rows)) {
      const wrap = make('div', 'plugin-result-table'), table = make('table', ''), head = make('thead', ''), row = make('tr', ''), body = make('tbody', '');
      for (const title of card.table.columns.slice(0, 12)) row.append(make('th', '', String(title).slice(0, 100)));
      head.append(row);
      for (const cells of card.table.rows.slice(0, 100)) if (Array.isArray(cells)) { const row = make('tr', ''); for (const value of cells.slice(0, 12)) row.append(make('td', '', String(value).slice(0, 2000))); body.append(row); }
      table.append(head, body); wrap.append(table); root.append(wrap);
    }
    return root;
  }
  function updateTool(block, result) {
    if (result === undefined) return;
    block.querySelectorAll('.plugin-result-card').forEach(el => el.remove());
    const card = render(result.pluginUI);
    if (card) block.querySelector('.tool-body')?.prepend(card);
  }
  window.IexaPluginCards = Object.freeze({ render, updateTool });
})();
