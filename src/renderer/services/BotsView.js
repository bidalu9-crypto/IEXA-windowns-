/* Native Bot management. app.js owns navigation; this module only loads its pane. */
(() => {
  'use strict';
  const view = document.getElementById('view-bots');
  const nav = document.querySelector('.nav-btn[data-view="bots"]');
  if (!view || !nav) return;

  let bots = [];
  let profiles = [];
  let activeProfileId = '';
  let tools = [];
  let toolsReady = false;
  let teams = [];
  let teamList;
  let teamChoices;
  let teamStatus;
  let teamGoal;
  let teamStart;
  let teamLoading = null;
  let teamTimer = null;
  let teamSubmitting = false;
  let teamEpoch = 0;
  const cancellingTeams = new Set();
  const terminalTeam = (team) => ['completed', 'failed', 'cancelled', 'canceled'].includes(team.status);
  const toolNames = (value) => Array.isArray(value) ? [...new Set(value.filter((name) => typeof name === 'string' && name))] : [];
  let loading = null;
  let working = false;
  let mounted = false;
  let status;
  let cards;
  let count;
  let createButton;
  let refreshButton;
  const pendingSessions = new Map();
  const text = (value) => typeof value === 'string' ? value : '';
  const element = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  };
  const button = (label, className, handler) => {
    const node = element('button', `bots-button ${className || ''}`, label);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  };
  const announce = (message, error = false) => {
    status.textContent = message;
    status.classList.toggle('is-error', error);
  };

  async function request(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store', ...options });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(text(data?.error) || `请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      throw error;
    }
    if (!data && response.status !== 204) throw new Error('服务返回了无效的数据，请刷新重试。');
    return data;
  }

  async function loadProfiles() {
    const config = await request('/api/profiles');
    if (!Array.isArray(config?.profiles)) throw new Error('模型配置响应缺少 profiles 列表。');
    profiles = config.profiles.filter((item) => item && typeof item.id === 'string');
    activeProfileId = text(config.activeProfileId);
  }

  function setBusy() {
    const busy = working || !!loading;
    createButton.disabled = busy;
    refreshButton.disabled = busy;
    cards.querySelectorAll('button').forEach((node) => { node.disabled = busy; });
    view.setAttribute('aria-busy', String(busy));
  }

  function profileLabel(id) {
    if (!id) {
      const active = profiles.find((profile) => profile.id === activeProfileId);
      return active ? `跟随当前模型 · ${text(active.name) || text(active.model) || active.id}` : '跟随当前模型配置';
    }
    const profile = profiles.find((item) => item.id === id);
    return profile ? [text(profile.name) || profile.id, text(profile.model)].filter(Boolean).join(' · ') : `模型配置不可用：${id}`;
  }

  function renderCards() {
    cards.replaceChildren();
    count.textContent = `${bots.length} 位 Bot`;
    if (!bots.length) {
      const empty = element('div', 'bots-empty');
      empty.append(element('h3', '', '为不同任务准备专属 Bot'), element('p', '', '保存各自的身份、明确记忆与模型配置，然后直接开始对话。'));
      cards.append(empty);
      return;
    }
    for (const bot of bots) {
      const card = element('article', 'bots-card');
      const heading = element('div', 'bots-card-heading');
      const avatar = element('span', 'bots-avatar', (text(bot.name).trim() || 'B').slice(0, 1));
      avatar.setAttribute('aria-hidden', 'true');
      heading.append(avatar, element('h3', '', text(bot.name) || '未命名 Bot'));
      card.append(heading, element('p', 'bots-description', text(bot.description) || '尚未填写简介'), element('p', 'bots-profile', `新聊天模型：${profileLabel(text(bot.profileId))}`));
      const details = element('dl', 'bots-details');
      for (const [label, value, fallback] of [['Bot 身份', bot.persona, '未设置'], ['显式长期记忆', bot.memory, '未保存记忆']]) {
        details.append(element('dt', '', label), element('dd', '', text(value) || fallback));
      }
      card.append(details);
      const timestamp = bot.updated || bot.created;
      const date = timestamp ? new Date(timestamp) : null;
      if (date && !Number.isNaN(date.getTime())) {
        const time = element('time', 'bots-updated', `更新于 ${date.toLocaleString()}`);
        time.dateTime = date.toISOString();
        card.append(time);
      }
      const actions = element('div', 'bots-card-actions');
      actions.append(
        button(pendingSessions.has(bot.id) ? '打开已创建对话' : '开始聊天', 'bots-primary', () => startChat(bot)),
        button('编辑', '', () => openEditor(bot)),
        button('导出 Bot 包', '', () => exportBot(bot)),
        button('删除', 'bots-danger', () => deleteBot(bot)),
      );
      card.append(actions);
      cards.append(card);
    }
  }

  function refresh() {
    if (loading) return loading;
    if (working) return Promise.resolve(false);
    announce('正在加载 Bot 与模型配置…');
    loading = (async () => {
      try {
        const [result, configResult, toolResult] = await Promise.allSettled([request('/api/bots'), loadProfiles(), request('/api/bots/tools')]);
        toolsReady = toolResult.status === 'fulfilled' && Array.isArray(toolResult.value?.tools);
        tools = toolsReady ? toolResult.value.tools.filter((tool) => typeof tool?.name === 'string') : [];
        if (result.status === 'rejected') throw result.reason;
        if (!Array.isArray(result.value?.bots)) throw new Error('Bot 响应缺少 bots 列表。');
        bots = result.value.bots.filter((bot) => bot && typeof bot.id === 'string' && bot.id);
        renderCards();
        renderTeamChoices();
        if (!toolsReady) {
          announce('工具列表读取失败，暂不能保存 Bot 或导入包；请刷新重试。', true);
        } else if (configResult.status === 'rejected') {
          announce(`Bot 已加载；模型配置读取失败：${configResult.reason.message}。可刷新重试，已有模型绑定会保留。`, true);
        } else {
          announce(bots.length ? `已加载 ${bots.length} 位 Bot。` : '还没有 Bot，点击“创建 Bot”开始。');
        }
        return true;
      } catch (error) {
        announce(`加载失败：${error.message}${bots.length ? '。当前仍显示上次加载的列表。' : ''}`, true);
        return false;
      } finally {
        loading = null;
        setBusy();
      }
    })();
    setBusy();
    return loading;
  }

  async function startChat(bot) {
    if (working || loading) return;
    working = true;
    setBusy();
    announce(`正在打开 ${text(bot.name) || 'Bot'} 的对话…`);
    try {
      if (typeof switchSession !== 'function') throw new Error('会话模块尚未就绪，请稍后重试。');
      let sessionId = pendingSessions.get(bot.id);
      if (!sessionId) {
        const result = await request(`/api/bots/${encodeURIComponent(bot.id)}/chat`, { method: 'POST' });
        sessionId = text(result?.session?.id);
        if (!sessionId) throw new Error('服务未返回有效的会话 ID。');
        // A failed UI transition must not create another conversation on retry.
        pendingSessions.set(bot.id, sessionId);
      }
      await switchSession(sessionId);
      document.querySelector('.nav-btn[data-view="chat"]')?.click();
      pendingSessions.delete(bot.id);
      if (typeof loadSessionList === 'function') await loadSessionList();
      announce('已打开 Bot 对话。');
    } catch (error) {
      announce(`打开对话失败：${error.message}`, true);
    } finally {
      working = false;
      renderCards();
      setBusy();
    }
  }

  async function deleteBot(bot) {
    if (working || loading) return;
    working = true;
    setBusy();
    try {
      const confirmed = await window.IexaDialogs.confirm(`确定删除 Bot“${text(bot.name) || '未命名 Bot'}”及其身份和显式长期记忆？此操作不可撤销。聊天历史会保留并可继续阅读；删除后，这些聊天无法继续执行，服务会返回 HTTP 409。`);
      if (!confirmed) return;
      await request(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'DELETE' });
      bots = bots.filter((item) => item.id !== bot.id);
      pendingSessions.delete(bot.id);
      renderCards();
      renderTeamChoices();
      announce('Bot 已删除。聊天历史仍可阅读；继续执行将返回 HTTP 409。');
    } catch (error) {
      announce(`删除失败：${error.message}`, true);
    } finally {
      working = false;
      setBusy();
    }
  }

  function openEditor(bot = null) {
    if (working || loading) return;
    const previousFocus = document.activeElement;
    const dialog = element('dialog', 'bots-dialog');
    dialog.setAttribute('aria-labelledby', 'bots-editor-title');
    const form = element('form', 'bots-form');
    const title = element('h2', '', bot ? '编辑 Bot' : '创建 Bot');
    title.id = 'bots-editor-title';
    const intro = element('p', 'bots-editor-intro', 'Bot 身份定义它如何回应；长期记忆仅保存你在这里明确填写的内容。工具访问与审批继承 IEXA 现有权限，不构成隔离沙箱。');
    const fieldset = element('fieldset', 'bots-fields');
    const fields = {};
    function addField(key, label, kind, help) {
      const row = element('div', 'bots-field');
      const caption = element('label', '', label);
      const input = element(kind, 'bots-input');
      input.id = `bots-editor-${key}`;
      input.name = key;
      caption.htmlFor = input.id;
      if (kind === 'input') input.type = 'text';
      if (kind === 'textarea') input.rows = key === 'description' ? 2 : 6;
      input.value = text(bot?.[key]);
      row.append(caption, input);
      if (help) {
        const hint = element('p', 'bots-field-hint', help);
        hint.id = `${input.id}-hint`;
        input.setAttribute('aria-describedby', hint.id);
        row.append(hint);
      }
      fieldset.append(row);
      fields[key] = input;
      return input;
    }
    const name = addField('name', '名称（必填）', 'input');
    name.required = true;
    name.autocomplete = 'off';
    addField('description', '简介', 'textarea', '简要说明适合交给这个 Bot 的任务。');
    addField('persona', 'Bot 身份 / 回应方式', 'textarea', '例如：你是一位代码审查助手，先给结论，再列证据与可执行修改。身份设置不改变工具权限。');
    addField('memory', '显式长期记忆', 'textarea', '填写需要长期保留的事实、偏好与约定；这里不表示自动记忆或独立数据沙箱。');
    const select = addField('profileId', '新聊天的模型配置', 'select', '此配置仅用于新聊天；留空时在新建聊天时使用 IEXA 当前模型。已有聊天保持原模型绑定，不会随此处修改而改变。');
    const addOption = (value, label) => {
      const option = element('option', '', label);
      option.value = value;
      select.append(option);
    };
    addOption('', profileLabel(''));
    profiles.forEach((profile) => addOption(profile.id, profileLabel(profile.id)));
    const existingId = text(bot?.profileId);
    if (existingId && !profiles.some((profile) => profile.id === existingId)) addOption(existingId, `保留原模型配置（当前不可用）：${existingId}`);
    select.value = existingId;
    fieldset.append(element('p', 'bots-field-hint', '工具权限默认不勾选（无工具）。授权仍受 IEXA 审批约束；授予 shell 意味着可执行程序，不等于沙箱。'));
    const toolPicker = element('fieldset', 'bots-tool-picker');
    toolPicker.append(element('legend', '', '允许使用的工具'));
    const selectedTools = toolNames(bot?.allowedTools);
    const availableTools = [...tools];
    for (const name of selectedTools) {
      if (!availableTools.some((tool) => tool.name === name)) availableTools.push({ name, description: '当前不可用的已保存权限；可取消勾选。' });
    }
    for (const tool of availableTools) {
      const label = element('label', 'bots-check');
      const input = element('input');
      input.type = 'checkbox';
      input.name = 'allowedTools';
      input.value = tool.name;
      input.checked = selectedTools.includes(tool.name);
      label.append(input, element('span', '', `${tool.name} — ${text(tool.description)}`));
      toolPicker.append(label);
    }
    if (!toolsReady) toolPicker.append(element('p', 'bots-form-error', '工具列表未加载，请关闭后刷新重试。'));
    fieldset.append(toolPicker);
    const errorBox = element('p', 'bots-form-error');
    errorBox.setAttribute('role', 'alert');
    const actions = element('div', 'bots-form-actions');
    const close = () => { if (!working) dialog.close(); };
    const cancel = button('取消', '', close);
    const submit = element('button', 'bots-button bots-primary', bot ? '保存修改' : '创建 Bot');
    submit.type = 'submit';
    actions.append(cancel, submit);
    form.append(title, intro, fieldset, errorBox, actions);
    dialog.append(form);
    dialog.addEventListener('cancel', (event) => { if (working) event.preventDefault(); });
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
      else createButton.focus();
    }, { once: true });
    name.addEventListener('input', () => name.setCustomValidity(''));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (working) return;
      if (!toolsReady) { errorBox.textContent = '工具列表未加载，无法保存权限。请关闭后刷新。'; return; }
      name.setCustomValidity(name.value.trim() ? '' : '请填写 Bot 名称。');
      if (!form.reportValidity()) return;
      const payload = {};
      for (const key of ['name', 'description', 'persona', 'memory', 'profileId']) payload[key] = fields[key].value;
      payload.name = payload.name.trim();
      payload.allowedTools = [...toolPicker.querySelectorAll('input:checked')].map((input) => input.value);
      working = true;
      fieldset.disabled = true;
      submit.disabled = true;
      cancel.disabled = true;
      submit.textContent = '正在保存…';
      errorBox.textContent = '';
      setBusy();
      let saved = false;
      try {
        await request(bot ? `/api/bots/${encodeURIComponent(bot.id)}` : '/api/bots', {
          method: bot ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        saved = true;
      } catch (error) {
        errorBox.textContent = `保存失败：${error.message}`;
      } finally {
        working = false;
        fieldset.disabled = false;
        submit.disabled = false;
        cancel.disabled = false;
        submit.textContent = bot ? '保存修改' : '创建 Bot';
        setBusy();
      }
      if (saved) {
        dialog.close();
        const refreshed = await refresh();
        if (refreshed && !status.classList.contains('is-error')) announce(bot ? 'Bot 修改已保存。' : 'Bot 已创建，可以开始聊天了。');
        else if (!refreshed) announce('Bot 已保存，但列表刷新失败，请点击“刷新”重新读取。', true);
      }
    });
    document.body.append(dialog);
    dialog.showModal();
    name.focus();
  }

  function packageValue(value) {
    if (value?.format !== 'iexa-bot' || value.version !== 1 || !value.bot || !text(value.bot.name).trim()) throw new Error('请选择 iexa-bot v1 格式的 JSON 包。');
    const bot = value.bot;
    if (['description', 'persona', 'memory'].some((key) => bot[key] !== undefined && typeof bot[key] !== 'string')) throw new Error('Bot 包中的文本字段格式无效。');
    if (bot.allowedTools !== undefined && (!Array.isArray(bot.allowedTools) || bot.allowedTools.some((item) => typeof item !== 'string'))) throw new Error('Bot 包的 allowedTools 必须是字符串数组。');
    // Only carry the public package schema; never import credentials or profile IDs.
    return { format: 'iexa-bot', version: 1, bot: { name: bot.name, description: text(bot.description), persona: text(bot.persona), memory: text(bot.memory), allowedTools: toolNames(bot.allowedTools) } };
  }

  function showDialog(title) {
    const previous = document.activeElement;
    const dialog = element('dialog', 'bots-dialog');
    const body = element('div', 'bots-form');
    const heading = element('h2', '', title);
    dialog.setAttribute('aria-label', title);
    body.append(heading);
    dialog.append(body);
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    dialog.addEventListener('close', () => { dialog.remove(); if (previous?.isConnected) previous.focus(); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    return { dialog, body };
  }

  function previewPackage(value, warning = '') {
    let pkg;
    try {
      pkg = packageValue(value);
      if (!toolsReady) throw new Error('工具列表未加载，请刷新后再导入。');
    } catch (error) { announce(`导入失败：${error.message}`, true); return; }
    const { dialog, body } = showDialog('预览并导入 Bot 包');
    if (warning) body.append(element('p', 'bots-permission-note', warning));
    const preview = element('dl', 'bots-package-preview');
    for (const [label, content] of [['名称', pkg.bot.name], ['简介', pkg.bot.description], ['Bot 身份', pkg.bot.persona], ['工具权限', pkg.bot.allowedTools.join('、') || '无工具'], ['显式长期记忆', pkg.bot.memory || '无记忆']]) {
      preview.append(element('dt', '', label), element('dd', '', content));
    }
    const unknown = pkg.bot.allowedTools.filter((name) => !tools.some((tool) => tool.name === name));
    body.append(preview, element('p', 'bots-field-hint', '仅支持 IEXA 原生 iexa-bot v1 包。请核对身份与工具权限。shell 授权允许执行程序，不等于沙箱。'));
    const label = element('label', 'bots-field', '选择本机模型配置（必选）');
    const select = element('select', 'bots-input');
    select.name = 'importProfileId';
    const placeholder = element('option', '', '请选择本机模型');
    placeholder.value = '';
    select.append(placeholder);
    for (const profile of profiles) {
      const option = element('option', '', profileLabel(profile.id));
      option.value = profile.id;
      select.append(option);
    }
    label.append(select);
    const feedback = element('p', 'bots-form-error');
    feedback.setAttribute('role', 'alert');
    if (unknown.length) feedback.textContent = `本机不支持以下工具：${unknown.join('、')}。请先修改包再导入。`;
    if (!profiles.length) feedback.textContent = '本机没有可选模型配置，请先在配置页添加模型并刷新。';
    let saving = false;
    const cancel = button('取消', '', () => { if (!saving) dialog.close(); });
    const confirm = button('确认导入', 'bots-primary', async () => {
      if (saving || unknown.length) return;
      if (!profiles.some((profile) => profile.id === select.value)) { feedback.textContent = '请选择本机模型配置。'; return; }
      saving = true;
      confirm.disabled = cancel.disabled = select.disabled = true;
      feedback.textContent = '';
      try {
        await request('/api/bots/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ package: pkg, profileId: select.value }) });
        dialog.close();
        const refreshed = await refresh();
        announce(refreshed ? 'Bot 包已导入。' : 'Bot 包已导入，列表刷新失败，请手动刷新。', !refreshed);
      } catch (error) { feedback.textContent = `导入失败：${error.message}`; }
      finally { saving = false; confirm.disabled = cancel.disabled = select.disabled = false; }
    });
    confirm.disabled = !!unknown.length || !profiles.length;
    dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
    const actions = element('div', 'bots-form-actions');
    actions.append(cancel, confirm);
    body.append(label, feedback, actions);
  }

  async function importFile(input) {
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Bot 包不能超过 2 MB。');
      const raw = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('无法读取文件。'));
        reader.readAsText(file);
      });
      previewPackage(JSON.parse(raw));
    } catch (error) { announce(`导入失败：${error.message}`, true); }
    finally { input.value = ''; }
  }

  function openTobsImport() {
    const { dialog, body } = showDialog('导入 Tobs 描述');
    body.append(element('p', 'bots-permission-note', '选择 .botharness/bot.json；可另选 SOUL.md 或 PERSONA.md。仅导入名字、简介及明确提供的人格，不导入记忆、权限或插件，不代表公共市场全兼容。转换本身不保存 Bot，下一步需预览并选择本机模型确认。'));
    const fileField = (name, caption, accept) => {
      const label = element('label', 'bots-field', caption);
      const input = element('input', 'bots-input');
      input.type = 'file'; input.name = name; input.accept = accept;
      label.append(input); body.append(label); return input;
    };
    const descriptorInput = fileField('tobsDescriptor', '.botharness/bot.json（必选，最多 16 KB）', '.json,application/json');
    const personaInput = fileField('tobsPersona', 'SOUL.md / PERSONA.md（可选，最多 16 KB 且不超过 12000 字符；不选则人格为空）', '.md,text/markdown,text/plain');
    const feedback = element('p', 'bots-form-error');
    feedback.setAttribute('role', 'alert');
    body.append(feedback);
    let converting = false;
    const read = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('无法读取文件。'));
      reader.readAsText(file);
    });
    const cancel = button('取消', '', () => { if (!converting) dialog.close(); });
    const convert = button('转换并预览', 'bots-primary', async () => {
      if (converting) return;
      const descriptorFile = descriptorInput.files?.[0];
      const personaFile = personaInput.files?.[0];
      converting = true;
      convert.disabled = cancel.disabled = descriptorInput.disabled = personaInput.disabled = true;
      feedback.textContent = '';
      try {
        if (!descriptorFile) throw new Error('请选择 .botharness/bot.json。');
        if (descriptorFile.size > 16 * 1024 || (personaFile && personaFile.size > 16 * 1024)) throw new Error('每个文件不能超过 16 KB。');
        const descriptor = JSON.parse((await read(descriptorFile)).replace(/^\uFEFF/, ''));
        if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error('描述文件必须是 JSON 对象。');
        const persona = personaFile ? (await read(personaFile)).replace(/^\uFEFF/, '') : '';
        if (persona.length > 12000) throw new Error('人格文本不能超过 12000 字符。');
        const result = await request('/api/bots/convert-tobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ descriptor, persona }) });
        const pkg = packageValue(result?.package);
        // Conversion may never grant imported permissions or carry memory.
        pkg.bot.persona = persona;
        pkg.bot.memory = '';
        pkg.bot.allowedTools = [];
        dialog.close();
        previewPackage(pkg, text(result.warning));
      } catch (error) { feedback.textContent = `转换失败：${error.message}`; }
      finally { converting = false; convert.disabled = cancel.disabled = descriptorInput.disabled = personaInput.disabled = false; }
    });
    dialog.addEventListener('cancel', (event) => { if (converting) event.preventDefault(); });
    const actions = element('div', 'bots-form-actions');
    actions.append(cancel, convert); body.append(actions);
  }

  async function openCatalog() {
    const { dialog, body } = showDialog('内置 Bot 模板');
    const list = element('div', 'bots-catalog');
    list.append(element('p', '', '正在读取模板…'));
    body.append(list, button('关闭', '', () => dialog.close()));
    try {
      const result = await request('/api/bots/catalog');
      if (!Array.isArray(result?.packages)) throw new Error('模板响应缺少 packages。');
      list.replaceChildren();
      for (const value of result.packages) {
        const pkg = packageValue(value);
        const item = element('article', 'bots-catalog-item');
        item.append(element('h3', '', pkg.bot.name), element('p', '', pkg.bot.description), button('预览模板', '', () => { dialog.close(); previewPackage(pkg); }));
        list.append(item);
      }
      if (!result.packages.length) list.append(element('p', '', '暂无内置模板。'));
    } catch (error) { list.replaceChildren(element('p', 'bots-form-error', `读取模板失败：${error.message}`)); }
  }

  async function exportBot(bot) {
    if (working || loading) return;
    working = true;
    setBusy();
    try {
      const data = await request(`/api/bots/${encodeURIComponent(bot.id)}/export`);
      const pkg = packageValue(data.package || data);
      delete pkg.bot.memory; // Export never includes explicit long-term memory by default.
      const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' }));
      const link = element('a');
      link.href = url;
      link.download = `${(text(bot.name) || 'bot').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80)}.iexa-bot.json`;
      document.body.append(link);
      try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      announce('Bot 包下载已发起，默认不含长期记忆。');
    } catch (error) { announce(`导出失败：${error.message}`, true); }
    finally { working = false; setBusy(); }
  }

  function renderTeamChoices() {
    if (!teamChoices) return;
    const selected = new Set([...teamChoices.querySelectorAll('input:checked')].map((input) => input.value));
    teamChoices.replaceChildren();
    for (const bot of bots) {
      const label = element('label', 'bots-check');
      const input = element('input');
      input.type = 'checkbox';
      input.name = 'teamBotId';
      input.value = bot.id;
      input.checked = selected.has(bot.id);
      input.disabled = teamSubmitting;
      label.append(input, element('span', '', text(bot.name) || bot.id));
      teamChoices.append(label);
    }
    if (bots.length < 2) teamChoices.append(element('p', 'bots-field-hint', '至少创建两位 Bot 后即可组队。'));
  }

  const readable = (value) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  function teamState(value) {
    return ({ queued: '等待中', planning: '规划中', running: '执行中', pending: '等待执行', completed: '已完成', failed: '失败', cancelling: '取消中', cancelled: '已取消', canceled: '已取消', skipped: '已跳过' })[value] || text(value) || '未知状态';
  }
  function renderTeams() {
    if (!teamList) return;
    teamList.replaceChildren();
    for (const team of teams) {
      const card = element('article', 'bots-team-card');
      card.dataset.teamId = team.id;
      card.append(element('h3', '', text(team.goal)), element('p', 'bots-team-state', teamState(team.status)));
      if (team.plan) {
        const details = element('details');
        details.append(element('summary', '', '模型生成的分工计划'), element('pre', 'bots-team-result', readable(team.plan)));
        card.append(details);
      }
      for (const [index, task] of (Array.isArray(team.tasks) ? team.tasks : []).entries()) {
        const item = element('section', 'bots-team-task');
        const botName = text(bots.find((bot) => bot.id === task.botId)?.name) || text(task.botId);
        item.append(element('h4', '', `${index + 1}. ${botName} · ${teamState(task.status)}`), element('p', '', text(task.instruction)));
        if (task.result !== undefined) item.append(element('pre', 'bots-team-result', readable(task.result)));
        if (task.error) item.append(element('p', 'bots-form-error', readable(task.error)));
        if (text(task.sessionId)) item.append(button('打开步骤会话', '', async () => {
          try { await switchSession(task.sessionId); document.querySelector('.nav-btn[data-view="chat"]')?.click(); }
          catch (error) { teamStatus.textContent = `打开会话失败：${error.message}`; }
        }));
        card.append(item);
      }
      if (team.error) card.append(element('p', 'bots-form-error', readable(team.error)));
      if (!terminalTeam(team)) {
        const cancel = button(cancellingTeams.has(team.id) ? '取消请求已提交，等待确认' : '取消团队任务', 'bots-danger', () => cancelTeam(team));
        cancel.disabled = cancellingTeams.has(team.id);
        card.append(cancel);
      }
      teamList.append(card);
    }
    if (!teams.length) teamList.append(element('p', 'bots-field-hint', '暂无团队任务。'));
  }

  function scheduleTeams() {
    clearTimeout(teamTimer);
    teamTimer = null;
    if (!view.classList.contains('active')) return;
    teamTimer = setTimeout(() => { teamTimer = null; void loadTeams(); }, 2500);
  }

  async function loadTeams() {
    if (!view.classList.contains('active') || !mounted) return;
    if (teamLoading) return teamLoading;
    const epoch = teamEpoch;
    teamLoading = (async () => {
      try {
        const data = await request('/api/bot-teams');
        if (!Array.isArray(data?.teams)) throw new Error('团队响应缺少 teams。');
        if (epoch !== teamEpoch) return;
        teams = data.teams.filter((team) => typeof team?.id === 'string');
        for (const team of teams) if (terminalTeam(team)) cancellingTeams.delete(team.id);
        renderTeams();
        if (!teamSubmitting) teamStatus.textContent = '团队状态已更新；仅在此页面显示时自动刷新。';
      } catch (error) { teamStatus.textContent = `读取团队状态失败：${error.message}`; }
      finally { teamLoading = null; scheduleTeams(); }
    })();
    return teamLoading;
  }

  async function cancelTeam(team) {
    if (cancellingTeams.has(team.id)) return;
    cancellingTeams.add(team.id);
    ++teamEpoch;
    renderTeams();
    teamStatus.textContent = '正在请求取消，任务状态以服务端确认为准。';
    try {
      const result = await request(`/api/bot-teams/${encodeURIComponent(team.id)}/cancel`, { method: 'POST' });
      ++teamEpoch;
      if (result?.team?.id === team.id) {
        teams = teams.map((item) => item.id === team.id ? result.team : item);
        if (terminalTeam(result.team)) cancellingTeams.delete(team.id);
      }
      renderTeams();
      teamStatus.textContent = '取消请求已发送；请以任务状态为准，未确认前不视为已取消。';
    } catch (error) { cancellingTeams.delete(team.id); renderTeams(); teamStatus.textContent = `取消失败：${error.message}`; }
    scheduleTeams();
  }

  function mountTeams(page) {
    const section = element('section', 'bots-teams');
    section.append(element('h2', '', '团队协作'), element('p', 'bots-subtitle', '选择 2–4 位 Bot 并填写目标。模型自动规划分工，服务端顺序执行步骤，前一步结果传给后一步。'));
    const form = element('form', 'bots-team-form');
    teamChoices = element('div', 'bots-team-choices');
    teamChoices.setAttribute('role', 'group');
    teamChoices.setAttribute('aria-label', '选择 2–4 位 Bot');
    const label = element('label', 'bots-field', '团队目标');
    teamGoal = element('textarea', 'bots-input');
    teamGoal.name = 'teamGoal';
    teamGoal.rows = 3;
    teamGoal.required = true;
    label.append(teamGoal);
    teamStart = element('button', 'bots-button bots-primary', '开始自动分工');
    teamStart.type = 'submit';
    teamStatus = element('p', 'bots-status');
    teamStatus.setAttribute('role', 'status');
    teamList = element('div', 'bots-team-list');
    form.append(teamChoices, label, teamStart);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (teamSubmitting) return;
      const botIds = [...teamChoices.querySelectorAll('input:checked')].map((input) => input.value);
      const goal = teamGoal.value.trim();
      if (botIds.length < 2 || botIds.length > 4 || !goal) { teamStatus.textContent = '请选择 2–4 位 Bot，并填写团队目标。'; return; }
      teamSubmitting = true;
      teamStart.disabled = teamGoal.disabled = true;
      renderTeamChoices();
      teamStatus.textContent = '正在提交团队目标…';
      ++teamEpoch;
      try {
        const data = await request('/api/bot-teams', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal, botIds }) });
        if (!text(data?.team?.id)) throw new Error('服务未返回有效的团队任务。');
        ++teamEpoch;
        teams = [data.team, ...teams.filter((item) => item.id !== data.team.id)];
        renderTeams();
        teamStatus.textContent = '团队任务已提交；正在等待模型规划与服务端执行。';
      } catch (error) { teamStatus.textContent = `启动团队失败：${error.message}`; }
      finally { teamSubmitting = false; teamStart.disabled = teamGoal.disabled = false; renderTeamChoices(); scheduleTeams(); }
    });
    section.append(form, teamStatus, teamList);
    page.append(section);
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    const page = element('div', 'bots-page');
    const header = element('header', 'bots-header');
    const heading = element('div', 'bots-heading');
    heading.append(element('p', 'bots-eyebrow', 'IEXA · 原生 Bot'), element('h2', '', 'Bot 团队'), element('p', 'bots-subtitle', '为每位 Bot 保存身份、显式长期记忆与模型配置。'));
    const actions = element('div', 'bots-header-actions');
    refreshButton = button('刷新', '', refresh);
    createButton = button('创建 Bot', 'bots-primary', () => openEditor());
    const fileInput = element('input', 'bots-file-input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => { void importFile(fileInput); });
    actions.append(button('内置模板', '', openCatalog), button('导入 JSON', '', () => fileInput.click()), button('导入 Tobs 描述', '', openTobsImport), fileInput, refreshButton, createButton);
    header.append(heading, actions);
    const note = element('p', 'bots-permission-note', '工具调用受各 Bot 白名单和 IEXA 审批双重限制；身份与记忆设置不是隔离沙箱。每次“开始聊天”创建一段 Bot 对话。');
    const toolbar = element('div', 'bots-toolbar');
    count = element('span', 'bots-count', '尚未加载');
    status = element('p', 'bots-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    toolbar.append(count, status);
    cards = element('div', 'bots-grid');
    page.append(header, note, toolbar, cards);
    mountTeams(page);
    view.append(page);
  }

  // Classic services load before app.js. Wait until all parser scripts have
  // initialized (including API_BASE) and app.js has installed navigation.
  function init() {
    nav.addEventListener('click', () => { mount(); void refresh(); void loadTeams(); });
    const observer = new MutationObserver(() => {
      if (!view.classList.contains('active')) { clearTimeout(teamTimer); teamTimer = null; }
      else { mount(); void loadTeams(); }
    });
    observer.observe(view, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('pagehide', () => { observer.disconnect(); clearTimeout(teamTimer); }, { once: true });
    if (view.classList.contains('active')) { mount(); void refresh(); void loadTeams(); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else queueMicrotask(init);
})();
