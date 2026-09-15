/* Native host forms and lazy, isolated extension panels. No plugin code executes in the host realm. */
(() => {
  'use strict';
  const make = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  function createToolForm(plugin, tool, options = {}) {
    const form = make('form', 'plugin-native-form'), controls = new Map();
    form.append(make('h3', '', tool.name), make('p', 'plugin-form-description', tool.description || ''));
    for (const [key, schema] of Object.entries(tool.parameters || {})) {
      const required = (tool.required || []).includes(key), label = make('label', 'plugin-form-field');
      label.append(make('span', '', `${key}${required ? ' *' : ''}`));
      let input;
      if (schema.type === 'boolean' || schema.enumValues?.length) {
        input = make('select', ''); const values = schema.type === 'boolean' ? ['true', 'false'] : schema.enumValues;
        input.append(new Option('请选择', '')); for (const value of values) input.append(new Option(value, value));
      } else if (['array', 'object'].includes(schema.type)) {
        input = make('textarea', ''); input.rows = 4; input.placeholder = schema.type === 'array' ? '[]' : '{}'; input.spellcheck = false;
      } else { input = make('input', ''); input.type = schema.type === 'integer' ? 'number' : 'text'; if (schema.type === 'integer') input.step = '1'; }
      input.name = key; input.required = required; label.append(input);
      if (schema.description) label.append(make('small', '', `${schema.description}${['array', 'object'].includes(schema.type) ? '（JSON）' : ''}`));
      controls.set(key, { input, schema, required }); form.append(label);
    }
    const advanced = make('details', 'plugin-form-advanced'), raw = make('textarea', ''); raw.setAttribute('aria-label', '高级 JSON 参数'); raw.spellcheck = false; raw.rows = 5;
    advanced.append(make('summary', '', '高级 JSON 模式'), raw); form.append(advanced);
    const readFields = () => {
      const args = Object.create(null);
      for (const [key, { input, schema, required }] of controls) {
        const value = input.value;
        if (!value && !required) continue;
        if (schema.type === 'boolean') args[key] = value === 'true';
        else if (schema.type === 'integer') { if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${key} 需要整数。`); args[key] = Number(value); }
        else if (schema.type === 'object' || schema.type === 'array') args[key] = JSON.parse(value);
        else args[key] = value;
      }
      return args;
    };
    advanced.addEventListener('toggle', () => { controls.forEach(({ input, required }) => { input.required = !advanced.open && required; }); if (advanced.open && !raw.value) { try { raw.value = JSON.stringify(readFields(), null, 2); } catch { raw.value = '{}'; } } });
    const actions = make('div', 'plugin-form-actions'), run = make('button', 'btn-secondary', '运行工具'), cancel = make('button', 'btn-secondary', '取消'), status = make('span', 'plugin-form-status');
    run.type = 'submit'; cancel.type = 'button'; cancel.hidden = true; status.setAttribute('role', 'status'); actions.append(run, cancel, status);
    const output = make('div', 'plugin-form-output'); form.append(actions, output);
    let controller, disposed = false;
    cancel.addEventListener('click', () => controller?.abort());
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (controller || disposed) return;
      try {
        const args = advanced.open ? JSON.parse(raw.value || '{}') : readFields();
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数需要 JSON 对象。');
        controller = new AbortController(); run.disabled = true; cancel.hidden = false; status.textContent = '正在执行…'; output.replaceChildren();
        const response = await fetch(`${options.apiBase || ''}/api/plugins/${encodeURIComponent(plugin.id)}/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: tool.name, arguments: args }), signal: controller.signal });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || '工具调用失败。'); if (disposed) return;
        const card = window.IexaPluginCards?.render(data.result?.pluginUI, { openPanel: false }); if (card) output.append(card);
        const details = make('details', 'plugin-form-raw'); details.open = !card; details.append(make('summary', '', '原始输出'), make('pre', '', data.result?.output || '')); output.append(details);
        status.textContent = data.result?.success ? '已完成' : '执行失败';
      } catch (error) { if (!disposed) status.textContent = controller?.signal.aborted ? '已取消' : error.message || String(error); }
      finally { controller = undefined; run.disabled = false; cancel.hidden = true; }
    });
    form.dispose = () => { disposed = true; controller?.abort(); };
    return form;
  }
  function createHost(options = {}) {
    let dialog, content, nav, disposeContent = () => {}, currentPlugin, opener;
    const request = async () => { const response = await fetch(`${options.apiBase || ''}/api/plugins`); const data = await response.json(); if (!response.ok) throw new Error(data.error || '读取拓展失败。'); return data.plugins || []; };
    const clear = () => { disposeContent(); disposeContent = () => {}; content?.replaceChildren(); };
    const close = () => { clear(); if (dialog?.open) dialog.close(); opener?.isConnected && opener.focus(); };
    const ensure = () => {
      if (dialog) return;
      dialog = make('dialog', 'plugin-workspace-dialog'); dialog.setAttribute('aria-label', '拓展工作台');
      const header = make('header', 'plugin-workspace-header'), identity = make('div', 'plugin-workspace-identity'); identity.append(make('strong', '', '拓展工作台'), make('small', ''));
      const refresh = make('button', 'btn-secondary btn-sm', '刷新'), dismiss = make('button', 'btn-secondary btn-sm', '关闭'); dismiss.type = refresh.type = 'button';
      dismiss.addEventListener('click', close); refresh.addEventListener('click', () => { if (currentPlugin) open(currentPlugin.id); }); header.append(identity, refresh, dismiss);
      nav = make('nav', 'plugin-workspace-nav'); nav.setAttribute('aria-label', '拓展面板'); content = make('div', 'plugin-workspace-content'); dialog.append(header, nav, content); document.body.append(dialog);
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }); dialog.addEventListener('close', clear);
    };
    const framePanel = (plugin, panel) => {
      const frame = make('iframe', 'plugin-workspace-frame'); frame.sandbox = 'allow-scripts'; frame.title = panel.title;
      const status = make('div', 'plugin-frame-status', '正在加载面板…'); status.setAttribute('role', 'status'); content.append(status, frame);
      let disposed = false, grant;
      const requestController = new AbortController();
      const revoke = () => { if (grant) { fetch(`${options.apiBase || ''}/api/plugins/${encodeURIComponent(plugin.id)}/ui-grant`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: grant.token }), keepalive: true }).catch(() => {}); grant = undefined; } };
      const timer = setTimeout(() => { if (!disposed) status.textContent = '面板加载较慢，可刷新重试。'; }, 10000);
      frame.addEventListener('load', () => { if (disposed || !grant || !frame.getAttribute('src')) return; clearTimeout(timer); status.hidden = true; window.IexaPluginBridge.connect(frame, plugin.id, options); });
      fetch(`${options.apiBase || ''}/api/plugins/${encodeURIComponent(plugin.id)}/ui-grant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ panelId: panel.id === '$legacy' ? undefined : panel.id }), signal: requestController.signal })
        .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || '创建面板失败。'); grant = data; if (disposed) { revoke(); return; } frame.src = `${options.apiBase || ''}${grant.url}`; })
        .catch(error => { if (!disposed) { clearTimeout(timer); status.hidden = false; status.textContent = error.message; } });
      disposeContent = () => { disposed = true; requestController.abort(); clearTimeout(timer); frame._iexaPluginDispose?.(); frame.remove(); revoke(); };
    };
    const toolsPanel = (plugin, toolName) => {
      if (!plugin.tools?.length) { content.append(make('p', 'plugin-workspace-empty', '该拓展没有声明工具。')); return; }
      const picker = make('select', 'plugin-tool-picker'); picker.setAttribute('aria-label', '选择工具');
      for (const tool of plugin.tools) picker.append(new Option(tool.name, tool.name));
      if (plugin.tools.some(tool => tool.name === toolName)) picker.value = toolName;
      const body = make('div', 'plugin-tools-content'); content.append(picker, body); let form;
      const select = () => { form?.dispose(); form = createToolForm(plugin, plugin.tools.find(tool => tool.name === picker.value), options); body.replaceChildren(form); };
      picker.addEventListener('change', select); select(); disposeContent = () => form?.dispose();
    };
    let epoch = 0;
    async function open(id, toolName) {
      const turn = ++epoch; ensure(); clear(); nav.replaceChildren();
      if (!dialog.open) { opener = document.activeElement; dialog.showModal(); }
      content.append(make('p', 'plugin-workspace-empty', '正在读取拓展…'));
      try {
        const plugins = await request(); if (turn !== epoch || !dialog.open) return;
        const plugin = plugins.find(item => item.id === id); currentPlugin = plugin;
        if (!plugin || !plugin.enabled || plugin.error) throw new Error(plugin?.error || '拓展已停用或卸载。请在拓展页面启用后打开。');
        dialog.querySelector('.plugin-workspace-identity strong').textContent = plugin.name;
        dialog.querySelector('.plugin-workspace-identity small').textContent = `${plugin.id} · v${plugin.version} · API ${plugin.apiVersion || 1}`;
        const panels = (plugin.contributions?.panels || []).map(panel => ({ ...panel, url: `/api/plugins/${encodeURIComponent(id)}/panel/${encodeURIComponent(panel.id)}/` }));
        if (plugin.uiURL) panels.push({ id: '$legacy', title: '插件界面', url: plugin.uiURL });
        panels.push({ id: '$tools', title: '工具调试' });
        const show = panel => {
          clear(); for (const button of nav.children) button.setAttribute('aria-pressed', String(button.dataset.panelId === panel.id));
          if (panel.id === '$tools') toolsPanel(plugin, toolName); else framePanel(plugin, panel);
        };
        for (const panel of panels) { const button = make('button', '', panel.title); button.type = 'button'; button.dataset.panelId = panel.id; button.addEventListener('click', () => show(panel)); nav.append(button); }
        show(toolName ? panels.at(-1) : panels[0]);
      } catch (error) { clear(); content.append(make('p', 'plugin-workspace-empty', error.message || String(error))); }
    }
    const invalidated = id => { if (dialog?.open && currentPlugin?.id === id) { epoch++; close(); } };
    return { open, close, invalidated };
  }
  window.IexaPluginWorkspace = Object.freeze({ createHost, createToolForm });
})();
