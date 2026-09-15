/* Versioned, revocable visual-extension transport. Plugin frames never receive app credentials. */
(() => {
  'use strict';
  function connect(frame, pluginId, options = {}) {
    frame._iexaPluginDispose?.();
    if (!frame.contentWindow || typeof MessageChannel === 'undefined') return () => {};
    const channel = new MessageChannel(), pending = new Map();
    let disposed = false;
    const context = () => ({ protocolVersion: 2, pluginId, theme: document.documentElement.dataset.theme || 'dark', motion: document.documentElement.dataset.motion || 'full', ...(options.context?.() || {}) });
    const post = data => { if (!disposed) channel.port1.postMessage(data); };
    const request = async (route, init = {}) => {
      const response = await fetch(`${options.apiBase || ''}/api/plugins/${encodeURIComponent(pluginId)}/${route}`, init);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `插件请求失败 (${response.status})`);
      return body;
    };
    channel.port1.onmessage = async ({ data: message }) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'iexa-plugin-cancel') { pending.get(message.requestId)?.abort(); return; }
      const legacy = message.type === 'iexa-plugin-call';
      if (!legacy && (message.type !== 'iexa-plugin-request' || message.version !== 2)) return;
      const id = message.requestId;
      if (typeof id !== 'string' || !/^[\w.-]{1,100}$/.test(id) || pending.has(id)) return;
      const respond = (result, error) => post({ type: legacy ? 'iexa-plugin-result' : 'iexa-plugin-response', version: 2, requestId: id, ...(error ? { error } : { result }) });
      if (pending.size >= 8) { respond(null, '插件并发请求已达上限。'); return; }
      const controller = new AbortController(); pending.set(id, controller);
      const timer = setTimeout(() => controller.abort(), 32000);
      try {
        let result;
        const method = legacy ? 'tool.invoke' : message.method;
        const params = legacy ? message : message.params || {};
        const json = (verb, body) => ({ method: verb, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
        if (method === 'tool.invoke') result = (await request('invoke', json('POST', { tool: params.tool, arguments: params.arguments || {} }))).result;
        else if (method === 'context.get') result = context();
        else if (method === 'state.get') result = await request('ui-state', { signal: controller.signal });
        else if (method === 'state.set') result = await request('ui-state', json('PUT', { revision: params.revision, value: params.value }));
        else throw new Error(`未知插件方法：${String(method).slice(0, 80)}`);
        if (controller.signal.aborted) throw new Error('插件请求已取消。');
        respond(result);
      } catch (error) { respond(null, controller.signal.aborted ? '插件请求已取消或超时。' : error.message || String(error)); }
      finally { clearTimeout(timer); pending.delete(id); }
    };
    channel.port1.start();
    const observer = new MutationObserver(() => post({ type: 'iexa-plugin-event', version: 2, event: 'context.changed', value: context() }));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-motion'] });
    const dispose = () => {
      if (disposed) return;
      post({ type: 'iexa-plugin-event', version: 2, event: 'disposed' });
      disposed = true; observer.disconnect();
      for (const controller of pending.values()) controller.abort();
      pending.clear(); channel.port1.onmessage = null; channel.port1.close();
      if (frame._iexaPluginDispose === dispose) delete frame._iexaPluginDispose;
    };
    frame._iexaPluginDispose = dispose;
    frame.contentWindow.postMessage({ type: 'iexa-plugin-init', version: 2, pluginId, context: context(), capabilities: ['tool.invoke', 'context.get', 'state.get', 'state.set'] }, '*', [channel.port2]);
    return dispose;
  }
  window.IexaPluginBridge = Object.freeze({ connect });
})();
