/* Public iframe SDK, no build step or external dependencies. */
(() => {
  'use strict';
  let port, counter = 0, context, connected = false;
  const pending = new Map(), listeners = new Set();
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const notify = (event, value) => { for (const listener of listeners) { try { listener(event, value); } catch (error) { console.error(error); } } };
  function dispose(reason = '插件界面已关闭。') {
    connected = false;
    for (const entry of pending.values()) entry.reject(new Error(reason));
    pending.clear(); port?.close(); port = undefined;
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'iexa-plugin-init' || event.data.version !== 2 || !event.ports?.[0]) return;
    dispose('插件连接已更新。'); port = event.ports[0]; context = event.data.context; connected = true;
    port.onmessage = ({ data }) => {
      if (data?.type === 'iexa-plugin-response' && data.version === 2) {
        const request = pending.get(data.requestId);
        if (request) data.error ? request.reject(new Error(data.error)) : request.resolve(data.result);
      } else if (data?.type === 'iexa-plugin-event') {
        if (data.event === 'context.changed') context = data.value;
        if (data.event === 'disposed') dispose();
        notify(data.event, data.value);
      }
    };
    port.start(); readyResolve(context); notify('context.changed', context);
  });
  async function request(method, params = {}, options = {}) {
    if (!connected) {
      let timer;
      try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('插件连接超时。')), 10000); })]); }
      finally { clearTimeout(timer); }
    }
    if (!connected || !port) throw new Error('插件连接已关闭。');
    if (options.signal?.aborted) throw new Error('插件请求已取消。');
    if (pending.size >= 8) throw new Error('插件请求过多。');
    return new Promise((resolve, reject) => {
      const id = `ui-${Date.now()}-${++counter}`;
      const finish = (fn, value) => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); pending.delete(id); fn(value); };
      const abort = () => { port?.postMessage({ type: 'iexa-plugin-cancel', version: 2, requestId: id }); finish(reject, new Error('插件请求已取消或超时。')); };
      const timer = setTimeout(abort, Math.min(35000, Math.max(1, options.timeoutMs || 35000)));
      pending.set(id, { resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      options.signal?.addEventListener('abort', abort, { once: true });
      try { port.postMessage({ type: 'iexa-plugin-request', version: 2, requestId: id, method, params }); }
      catch (error) { finish(reject, error); }
    });
  }
  window.addEventListener('pagehide', () => dispose());
  window.IexaPlugin = Object.freeze({
    ready, request, getContext: () => request('context.get'),
    invoke: (tool, args = {}, options = {}) => request('tool.invoke', { tool, arguments: args }, options),
    state: Object.freeze({ get: () => request('state.get'), set: (value, revision) => request('state.set', { value, revision }) }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
})();
