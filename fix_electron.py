import sys
path = r'C:\Users\Administrator\Desktop\iEXA-WIN\electron-entry.js'
content = open(path, 'r', encoding='utf-8').read()

old = "  if (process.env.IEXA_WORKSPACE) return; // caller explicitly set it\n  const base = path.join(__dirname, 'workspace');\n  const instance = 'instance-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);\n  process.env.IEXA_WORKSPACE = path.join(base, instance);\n  fs.mkdirSync(process.env.IEXA_WORKSPACE, { recursive: true });\n  console.log('[IEXA] Instance workspace:', process.env.IEXA_WORKSPACE);\n  console.log('[IEXA] Hit Ctrl+C / close window to stop this instance.');"

new = "  if (process.env.IEXA_WORKSPACE) return; // caller explicitly set it\n  const base = path.join(__dirname, 'workspace');\n  process.env.IEXA_WORKSPACE = base;\n  fs.mkdirSync(process.env.IEXA_WORKSPACE, { recursive: true });\n  console.log('[IEXA] Workspace:', process.env.IEXA_WORKSPACE);\n  console.log('[IEXA] Hit Ctrl+C / close window to stop this instance.');"

if old in content:
    content = content.replace(old, new, 1)
    open(path, 'w', encoding='utf-8').write(content)
    print('OK - fixed')
else:
    print('NOT FOUND')
    idx = content.find('ensureInstanceWorkspace')
    if idx >= 0:
        print(repr(content[idx:idx+400]))