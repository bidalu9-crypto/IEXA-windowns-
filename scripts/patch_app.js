import os

app_js = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\renderer\app.js'

with open(app_js, 'r', encoding='utf-8') as f:
    content = f.read()

print(f'File size: {len(content)}')

# 1. Add formatContextTokensForDisplay helper before fetchModels
helper = """function formatContextTokensForDisplay(tokens) {
  if (!tokens || tokens < 1000) return String(tokens);
  return (tokens / 1000).toFixed(tokens >= 100000 ? 0 : 1).replace(/\\.0$/, '') + 'K';
}

"""

idx = content.find('async function fetchModels() {')
if idx >= 0:
    content = content[:idx] + helper + content[idx:]
    print('OK: helper added')
else:
    print('FAIL: fetchModels not found')

# 2. Patch fetchModels dropdown to show contextWindow
old1 = """    select.innerHTML = '<option value="">— 选择模型 —</option>' +
      data.models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');"""

new1 = """    // Models can be strings or objects { id, contextWindow?, maxOutputTokens? }
    const modelList = data.models.map(m => {
      if (typeof m === 'string') return { id: m };
      return { id: m.id, contextWindow: m.contextWindow };
    });
    select.innerHTML = '<option value="">— 选择模型 —</option>' +
      modelList.map(m => {
        const label = m.contextWindow ? m.id + '  (' + formatContextTokensForDisplay(m.contextWindow) + ')' : m.id;
        const val = m.id + '\\u0000' + (m.contextWindow || '');
        return `<option value="${escapeHtml(val)}">${escapeHtml(label)}</option>`;
      }).join('');"""

count1 = content.count(old1)
print(f'old1 occurrences: {count1}')
if count1 > 0:
    content = content.replace(old1, new1, 1)
    print('OK: dropdown patched')
else:
    print('FAIL: old1 not found')
    # Debug: write a snippet
    idx = content.find('data.models')
    if idx >= 0:
        with open(r'C:\Users\Administrator\Desktop\iEXA-WIN\scripts\debug_app.txt', 'w', encoding='utf-8') as f:
            f.write(repr(content[idx:idx+300]))

# 3. Patch saveProfile to send contextWindow
old2 = """async function saveProfile() {
  const id = document.getElementById('profileEditorId').value;
  const profile = {
    id: id || undefined,
    name: document.getElementById('profileEditorName').value.trim(),
    provider: document.getElementById('profileEditorProvider').value,
    model: document.getElementById('profileEditorModel').value.trim(),
    apiKey: document.getElementById('profileEditorApiKey').value.trim(),
    baseURL: document.getElementById('profileEditorBaseURL').value.trim(),
  };

  if (!profile.name) profile.name = profile.model || '未命名';
  if (!profile.model) { alert('请输入模型 ID。'); return; }

  await fetch(`${API_BASE}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });"""

new2 = """async function saveProfile() {
  const id = document.getElementById('profileEditorId').value;
  const modelSelect = document.getElementById('profileEditorModelSelect');
  let profileModel = document.getElementById('profileEditorModel').value.trim();
  let contextWindow = undefined;
  if (modelSelect && modelSelect.value) {
    try {
      const parts = modelSelect.value.split('\\u0000');
      if (parts.length >= 2) {
        profileModel = parts[0];
        const cw = Number(parts[1]);
        if (Number.isFinite(cw) && cw > 0) contextWindow = cw;
      }
    } catch { /* ignore */ }
  }
  const profile = {
    id: id || undefined,
    name: document.getElementById('profileEditorName').value.trim(),
    provider: document.getElementById('profileEditorProvider').value,
    model: profileModel,
    apiKey: document.getElementById('profileEditorApiKey').value.trim(),
    baseURL: document.getElementById('profileEditorBaseURL').value.trim(),
    contextWindow: contextWindow,
  };

  if (!profile.name) profile.name = profile.model || '未命名';
  if (!profile.model) { alert('请输入模型 ID。'); return; }

  await fetch(`${API_BASE}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });"""

count2 = content.count(old2)
print(f'old2 occurrences: {count2}')
if count2 > 0:
    content = content.replace(old2, new2, 1)
    print('OK: saveProfile patched')
else:
    print('FAIL: old2 not found')

with open(app_js, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'New size: {len(content)}')
print('Done')