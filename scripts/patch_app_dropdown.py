import os

app_js = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\renderer\app.js'

with open(app_js, 'r', encoding='utf-8') as f:
    content = f.read()

print(f'File size: {len(content)}')

# Find the fetchModels dropdown rendering
old = """    select.innerHTML = '<option value="">— 选择模型 —</option>' +
      data.models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');"""

new = """    // Models can be strings or objects { id, contextWindow?, maxOutputTokens? }
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

count = content.count(old)
print(f'dropdown occurrences: {count}')
if count > 0:
    content = content.replace(old, new, 1)
    print('OK: dropdown patched')
else:
    print('FAIL: dropdown not found')
    # Debug
    idx = content.find('data.models.map')
    if idx >= 0:
        print(repr(content[idx:idx+200]))

with open(app_js, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'New size: {len(content)}')