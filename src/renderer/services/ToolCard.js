/* Tool card interactions: the input/output/diff tabs and the Inspect jump.
 *
 * DeepSeek Harness renders a tool call in place and offers Inspect as the
 * bridge into the trajectory ledger. Keeping that split here means a card
 * never grows a second full-height presentation of the same call.
 */
(function () {
  'use strict';

  function tabs(block) {
    return block ? [...block.querySelectorAll('[data-tool-tab]')] : [];
  }

  function showTab(block, name) {
    if (!block) return;
    const body = block.querySelector('.tool-body');
    if (!body) return;
    for (const button of tabs(block)) {
      const active = button.dataset.toolTab === name;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const pane of body.querySelectorAll('[data-pane]')) {
      pane.hidden = pane.dataset.pane !== name;
    }
    block.dataset.activeToolTab = name;
  }

  /* The tab strip and its panes. Live tool cards and restored history must
   * share one markup: the first cut only gave the live path tabs, so reopening
   * a conversation showed an input block with no output at all. */
  function bodyMarkup(id) {
    const label = (key, fallback) => {
      try {
        const value = window.IexaI18n ? window.IexaI18n.t(key) : key;
        return value === key ? fallback : value;
      } catch { return fallback; }
    };
    return '' +
      '<div class="tool-tabs" role="tablist">' +
        '<button type="button" role="tab" class="tool-tab is-active" data-tool-tab="input" aria-selected="true">' + label('tool.tab.input', 'Input') + '</button>' +
        '<button type="button" role="tab" class="tool-tab" data-tool-tab="output" aria-selected="false">' + label('tool.tab.output', 'Output') + '</button>' +
        '<span class="tool-tabs-spacer"></span>' +
        '<button type="button" class="tool-inspect" data-tool-inspect title="' + label('tool.tab.inspect', 'Inspect') + '">' + label('tool.tab.inspect', 'Inspect') + '</button>' +
      '</div>' +
      '<div class="tool-pane" data-pane="input"><pre class="tool-args"></pre></div>' +
      '<div class="tool-pane" data-pane="output" hidden><pre class="tool-result"></pre></div>' +
      '<div class="tool-pane" data-pane="diff" hidden></div>';
  }

  function renderResult(block, info) {
    if (!block) return;
    block.dataset.hasResult = '1';
    if (info && info.success === false) block.dataset.resultError = '1';
  }

  function inspect(block) {
    if (!block) return;
    const callId = block.dataset.toolId || '';
    window.IexaTrajectory?.focusCall?.(callId);
  }

  document.addEventListener('click', (event) => {
    // Only the tab buttons own data-tool-tab. Matching the bare attribute also
    // hit the block itself once a tab had been chosen, which swallowed the
    // header click and made the card impossible to collapse.
    const tab = event.target.closest && event.target.closest('.tool-tab[data-tool-tab]');
    if (tab) {
      event.preventDefault();
      event.stopPropagation();
      showTab(tab.closest('.tool-block'), tab.dataset.toolTab);
      return;
    }
    const inspectButton = event.target.closest && event.target.closest('[data-tool-inspect]');
    if (inspectButton) {
      event.preventDefault();
      event.stopPropagation();
      inspect(inspectButton.closest('.tool-block'));
    }
  }, true);

  window.IexaToolCard = { showTab, renderResult, bodyMarkup };
})();
