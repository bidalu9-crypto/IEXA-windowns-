'use strict';

/* Inject runCurrentModelAcceptance.toString() into an ALREADY AUTHENTICATED
 * IEXA renderer. Every dependency used by the function is deliberately local.
 * The browser supplies its existing HttpOnly session cookie to same-origin
 * fetch; this module never reads model settings, credentials or cookie values.
 *
 * The model chooses every desktop operation. The temporary Bot supplies an
 * actual runtime tool allowlist, rather than relying on a prompt instruction.
 * Sessions and the Bot remain available as evidence. Watchdog limits supplement
 * server cancellation; poll.cancelSettled distinguishes a request from a
 * confirmed stopped runtime. status=completed is NOT business verification.
 */
async function runCurrentModelAcceptance(options = {}) {
  if (!options || typeof options.goal !== 'string' || !options.goal.trim()) throw Error('A nonempty goal is required.');
  if (typeof options.runId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(options.runId)) throw Error('runId must contain 1-100 letters, digits, underscores or hyphens.');
  if (options.originalSessionId !== undefined && (typeof options.originalSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(options.originalSessionId))) throw Error('originalSessionId is invalid.');
  if (window.__iexaAcceptance && (!window.__iexaAcceptance.done || window.__iexaAcceptance.status === 'cancel_pending')) throw Error('An acceptance run is active or has unconfirmed cancellation in this renderer.');

  const maxTools = options.maxTools ?? 40, maxRuntimeMs = options.maxRuntimeMs ?? 7 * 60_000;
  if (!Number.isInteger(maxTools) || maxTools < 1 || maxTools > 80 || !Number.isInteger(maxRuntimeMs) || maxRuntimeMs < 1000 || maxRuntimeMs > 8 * 60_000) throw Error('Invalid bounded acceptance limits.');
  const state = window.__iexaAcceptance = {
    runId: options.runId, status: 'initializing', startedAt: Date.now(),
    deadlineAt: Date.now() + maxRuntimeMs, sessionId: null, botId: null,
    bindingSessionId: null, model: null, events: [], answer: '', images: [],
    toolCalls: 0, calls: [], done: false, maxTools, maxRuntimeMs, droppedImages: 0,
    originalSessionId: options.originalSessionId || null,
  };
  const controller = new AbortController();
  const calls = new Map(), startedCalls = new Set(), approved = new Set();
  let reader, deadline, cancelTask, terminalReceived = false;

  function brief() {
    return { runId: state.runId, status: state.status, sessionId: state.sessionId,
      botId: state.botId, bindingSessionId: state.bindingSessionId, model: state.model,
      done: state.done, deadlineAt: state.deadlineAt, error: state.error || null };
  }
  // Strip media from ordinary events and from tool/permission metadata. Pixels
  // have one bounded home in images; no headers or authentication data is read.
  function eventData(data) {
    return JSON.parse(JSON.stringify(data, (key, value) => {
      if (/^(?:imageData|images|base64|image_url|imageUrl|dataUrl)$/i.test(key)) return undefined;
      if (/^(?:apiKey|api_key|authorization|cookie|password|accessToken|refreshToken|secret)$/i.test(key)) return '[REDACTED]';
      return value;
    }));
  }
  function record(event, data) {
    state.events.push({ event, data: eventData(data), receivedAt: Date.now() });
  }
  async function json(url, method = 'GET', body, independent = false) {
    const abort = new AbortController();
    const forward = () => abort.abort();
    if (!independent) {
      controller.signal.addEventListener('abort', forward, { once: true });
      if (controller.signal.aborted) abort.abort();
    }
    const timer = setTimeout(() => abort.abort(), 15_000);
    try {
      const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store',
        headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: abort.signal });
      let data;
      try { data = await response.json(); } catch { throw Error(`${method} ${url}: expected JSON (HTTP ${response.status}).`); }
      if (!response.ok) throw Error(`${method} ${url}: HTTP ${response.status}: ${String(data.error || data.message || 'Request failed').slice(0, 1500)}`);
      return data;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', forward);
    }
  }
  function finish(status) {
    clearTimeout(deadline);
    state.status = status;
    state.done = true;
    state.finishedAt = Date.now();
  }
  async function cancel(reason = 'external_stop') {
    if (cancelTask) return cancelTask;
    if (state.done) return brief();
    state.cancelRequested = true;
    state.cancelReason = String(reason).slice(0, 500);
    state.status = 'cancelling';
    clearTimeout(deadline);
    controller.abort();
    // Aborting a local fetch is not proof that the server executor has stopped.
    // Explicitly cancel this run's session, then query the real runtime state.
    cancelTask = (async () => {
      if (!state.sessionId) {
        state.cancelSettled = true;
        finish('cancelled');
        return brief();
      }
      try {
        const result = await json('/api/cancel', 'POST', { sessionId: state.sessionId }, true);
        state.cancelAcknowledged = result.ok === true && result.sessionId === state.sessionId;
        state.cancelSettled = result.settled === true;
        const stopCheckingAt = Date.now() + 12_000;
        while (!state.cancelSettled && Date.now() < stopCheckingAt) {
          const observed = await json('/api/agent/state?sessionId=' + encodeURIComponent(state.sessionId), 'GET', undefined, true);
          state.cancelSettled = observed.running === false;
          state.runtimeStatus = observed.state?.status || null;
          if (!state.cancelSettled) await new Promise(resolve => setTimeout(resolve, 250));
        }
      } catch (error) {
        state.cancelError = String(error.message || error);
        state.cancelSettled = false;
      }
      finish(state.cancelSettled ? 'cancelled' : 'cancel_pending');
      return brief();
    })();
    return cancelTask;
  }
  window.__iexaAcceptanceControl = { runId: state.runId, stop: cancel };
  deadline = setTimeout(() => { void cancel('runtime_limit').catch(error => {
    state.cancelError = String(error.message || error); finish('cancel_pending');
  }); }, maxRuntimeMs);

  function receiveImage(data) {
    if (typeof data.imageData !== 'string' || !data.imageData) return;
    if (state.images.length >= maxTools) { state.droppedImages++; return; }
    state.images.push({ toolCallId: data.id, mimeType: data.imageMimeType || 'application/octet-stream',
      base64: data.imageData, receivedAt: Date.now() });
  }
  async function onEvent(event, data) {
    if (state.cancelRequested) return;
    // The regular server sends full accumulated content. Delta mode is not
    // requested, but accepting its explicit event avoids concatenating full text.
    if (event === 'text') { state.answer = String(data.content || ''); return; }
    if (event === 'text_delta') {
      state.answer = (data.reset === true ? '' : state.answer) + String(data.content || ''); return;
    }
    if (event === 'tool_start' || event === 'tool_complete') {
      if (data.name !== 'desktop_control' || typeof data.id !== 'string' || !data.id) {
        state.error = 'A non-desktop or malformed tool call was emitted.';
        await cancel('unexpected_tool'); return;
      }
      startedCalls.add(data.id);
      if (startedCalls.size > maxTools) { await cancel('tool_limit'); return; }
    }
    if (event === 'tool_complete') {
      record(event, data);
      if (!calls.has(data.id)) {
        const call = { id: data.id, name: data.name, args: eventData(data.args || {}), completedAt: Date.now() };
        calls.set(data.id, call); state.calls.push(call); state.toolCalls = calls.size;
      }
    } else if (event === 'tool_result') {
      const call = calls.get(data.id);
      if (!call) { state.error = 'A result has no matching desktop tool call.'; await cancel('unexpected_tool_result'); return; }
      receiveImage(data);
      record(event, data);
      call.success = data.success;
      call.executionStatus = data.executionStatus;
      call.resultAt = Date.now();
      // Infrastructure failure needs a repair, not repeated paid model turns.
      const infrastructureLost = data.success === false && /Desktop agent is missing|matching capability hash are required/.test(String(data.output || ''));
      state.infrastructureFailures = infrastructureLost ? (state.infrastructureFailures || 0) + 1 : 0;
      if (state.infrastructureFailures >= 2) { await cancel('repeated_infrastructure_failure'); return; }
      // Stop at the last allowed completed tool, before asking for more work.
      if (state.toolCalls >= maxTools) await cancel('tool_limit');
    } else if (event === 'permission_required') {
      record(event, data);
      if (data.sessionId !== state.sessionId || data.tool?.name !== 'desktop_control' ||
          typeof data.id !== 'string' || typeof data.toolCallId !== 'string' ||
          !calls.has(data.toolCallId) || state.toolCalls > maxTools) {
        state.error = 'Permission request is outside this desktop acceptance session.';
        await cancel('unexpected_permission'); return;
      }
      if (!approved.has(data.id)) {
        approved.add(data.id);
        try {
          await json('/api/permissions/approve', 'POST', { id: data.id, scope: 'once' });
        } catch (error) {
          state.error = String(error.message || error);
          await cancel('permission_approval_failed');
        }
      }
    } else if (event === 'usage') {
      record(event, data);
    } else if (event === 'error') {
      record(event, data);
      state.error = String(data.message || 'Model stream failed.');
      terminalReceived = true; finish('failed');
    } else if (event === 'done') {
      record(event, data);
      state.stopReason = data.stopReason || null;
      terminalReceived = true; finish('completed');
    } else if (event === 'cancelled') {
      terminalReceived = true; state.cancelSettled = true; finish('cancelled');
    } else if (event === 'paused') {
      state.error = 'The acceptance turn paused before completion.';
      await cancel('paused_turn');
    }
  }
  async function pump() {
    state.status = 'running';
    const response = await fetch('/api/chat', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ sessionId: state.sessionId, message: options.goal }), signal: controller.signal });
    if (!response.ok) {
      let detail = '';
      try { const data = await response.json(); detail = String(data.error || data.message || '').slice(0, 1500); } catch { /* no raw response bodies */ }
      throw Error(`Chat HTTP ${response.status}${detail ? ': ' + detail : ''}`);
    }
    if (!/text\/event-stream/i.test(response.headers.get('Content-Type') || '') || !response.body) throw Error('Chat did not return an SSE body.');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '', event = 'message', dataLines = [];
    async function dispatch() {
      if (dataLines.length) {
        const text = dataLines.join('\n');
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Malformed SSE event payload.');
        await onEvent(event, parsed);
      }
      event = 'message'; dataLines = [];
    }
    async function consume(final = false) {
      let newline;
      while (!state.done && !state.cancelRequested && (newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (!line) { await dispatch(); continue; }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') dataLines.push(value);
      }
      if (final && !state.done && !state.cancelRequested) {
        if (pending) {
          pending += '\n'; await consume(false);
        }
        await dispatch();
      }
    }
    try {
      while (!state.done && !state.cancelRequested) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        await consume(chunk.done);
        if (chunk.done) break;
      }
      if (!terminalReceived && !state.cancelRequested) throw Error('Chat stream ended without a terminal event.');
    } finally {
      try { await reader.cancel(); } catch { /* preserve the actual terminal result */ }
      reader.releaseLock(); reader = null;
    }
  }

  try {
    const created = await json('/api/sessions', 'POST', {});
    const binding = created.session?.modelBinding;
    state.bindingSessionId = created.session?.id || null;
    if (!state.bindingSessionId || !binding?.profileId) throw Error('The current model has no configured session binding.');
    // Persist only the explicitly safe routing fields returned by the server.
    state.model = { profileId: binding.profileId, provider: binding.provider, model: binding.model,
      contextWindow: binding.contextWindow, maxOutputTokens: binding.maxOutputTokens };
    const createdBot = await json('/api/bots', 'POST', {
      name: ('Desktop acceptance ' + state.runId).slice(0, 80), description: 'Temporary real-model desktop acceptance evidence',
      persona: '通过允许的 desktop_control 工具自主完成用户的桌面任务；操作前观察真实界面，操作后核对实际结果。',
      memory: '', profileId: binding.profileId, allowedTools: ['desktop_control'],
    });
    state.botId = createdBot.bot?.id || null;
    if (!state.botId || createdBot.bot?.allowedTools?.length !== 1 || createdBot.bot.allowedTools[0] !== 'desktop_control') throw Error('The acceptance Bot did not retain its desktop-only tool allowlist.');
    const chat = await json('/api/bots/' + encodeURIComponent(state.botId) + '/chat', 'POST', {});
    state.sessionId = chat.session?.id || null;
    if (!state.sessionId || chat.session?.modelBinding?.profileId !== binding.profileId) throw Error('The acceptance conversation has no matching current-model binding.');
    if (state.originalSessionId) {
      await json('/api/sessions/' + encodeURIComponent(state.originalSessionId) + '/activate', 'POST', {});
      state.originalSessionRestored = true;
    }
    if (state.cancelRequested) return brief();
    state.status = 'starting';
    // Return before inference starts. Runtime.evaluate(awaitPromise=true) waits
    // only for initialization, not the model's seven-minute background pump.
    setTimeout(() => {
      if (state.cancelRequested || state.done) return;
      void pump().catch(async error => {
        if (state.cancelRequested) return;
        state.error = String(error.message || error);
        record('error', { message: state.error, source: 'acceptance_transport' });
        await cancel('transport_error');
      }).catch(error => {
        state.error = String(error.message || error); finish('cancel_pending');
      });
    }, 0);
  } catch (error) {
    if (!state.cancelRequested) {
      state.error = String(error.message || error);
      record('error', { message: state.error, source: 'acceptance_initialization' });
      finish('failed');
    }
    if (state.originalSessionId && !state.originalSessionRestored) {
      try {
        await json('/api/sessions/' + encodeURIComponent(state.originalSessionId) + '/activate', 'POST', {}, true);
        state.originalSessionRestored = true;
      } catch (restoreError) { state.restoreError = String(restoreError.message || restoreError); }
    }
  }
  return brief();
}

// These exported functions are also self-contained when injected via toString().
// Polling omits image bytes by default; opt in only when saving image artifacts.
function pollCurrentModelAcceptance(options = {}) {
  const state = window.__iexaAcceptance;
  if (!state) return null;
  const from = Number.isSafeInteger(options.eventsFrom) && options.eventsFrom >= 0 ? options.eventsFrom : 0;
  const imagesFrom = Number.isSafeInteger(options.imagesFrom) && options.imagesFrom >= 0 ? options.imagesFrom : 0;
  return { ...state, eventCount: state.events.length, imageCount: state.images.length,
    events: state.events.slice(from),
    images: state.images.slice(imagesFrom).map(image => options.includeImages === true ? { ...image }
      : { toolCallId: image.toolCallId, mimeType: image.mimeType, receivedAt: image.receivedAt, base64Characters: image.base64.length }) };
}

async function stopCurrentModelAcceptance(reason = 'external_stop') {
  const state = window.__iexaAcceptance, control = window.__iexaAcceptanceControl;
  if (!state) return null;
  if (!control || control.runId !== state.runId) throw Error('The acceptance cancellation controller is absent.');
  return control.stop(reason);
}

module.exports = { runCurrentModelAcceptance, pollCurrentModelAcceptance, stopCurrentModelAcceptance };
