/* Typed server lifecycle -> tool-card presentation. Never infers success from elapsed time. */
(() => {
  'use strict';
  const states = Object.freeze({
    queued: ['queued','排队中'], awaiting_approval: ['awaiting-approval','等待批准'],
    running: ['running','执行中'], cancelling: ['cancelling','正在停止'],
    completed: ['done',undefined], failed: ['error',undefined], denied: ['denied','已拒绝'],
    cancelled: ['cancelled','已取消'], timed_out: ['timed-out','超时'], unknown: ['unknown','未记录结果'],
  });
  const terminal = new Set(['completed','failed','denied','cancelled','timed_out']);
  function present(block, status, render) {
    const state = Object.hasOwn(states, status) ? status : 'unknown';
    block.dataset.executionStatus = state;
    render(block, ...states[state]);
  }
  function apply(block, event, render) {
    if (!block || !event || event.version !== 1 || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      typeof event.runId !== 'string' || !Object.hasOwn(states, event.status)) return false;
    if (block.dataset.toolRun && block.dataset.toolRun !== event.runId) return false;
    if (Number(block.dataset.toolSequence || 0) >= event.sequence) return false;
    if (terminal.has(block.dataset.executionStatus)) return false;
    block.dataset.toolRun = event.runId; block.dataset.toolSequence = String(event.sequence);
    if (Number.isFinite(event.startedAt)) block.dataset.startedAt = String(event.startedAt);
    present(block, event.status, render);
    return true;
  }
  function applyResult(block, result, render) {
    // Prefer a recorded server terminal over legacy boolean-only results.
    const status = terminal.has(block.dataset.executionStatus) ? block.dataset.executionStatus
      : terminal.has(result?.executionStatus) ? result.executionStatus
      : !result ? 'unknown' : result.cancelled ? 'cancelled' : result.timedOut ? 'timed_out'
      : result.success === true ? 'completed' : result.success === false ? 'failed' : 'unknown';
    present(block, status, render);
  }
  window.IexaToolLifecycleView = Object.freeze({ apply, applyResult });
})();
