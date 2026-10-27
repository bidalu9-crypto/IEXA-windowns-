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
    block.dataset.toolTab = name;
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
    const tab = event.target.closest && event.target.closest('[data-tool-tab]');
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

  window.IexaToolCard = { showTab, renderResult };
})();
