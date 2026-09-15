from pathlib import Path
p=Path('src/renderer/app.js')
s=p.read_text(encoding='utf-8')
marker='// ---- Thinking Level (iOS-style capsule) ----\n'
if 'let modelSelectorProfiles = [];\n\n' not in s[:s.index(marker)+len(marker)]:
    s=s.replace(marker, marker+'let modelSelectorProfiles = [];\n\n', 1)
# Remove the later duplicate declaration.
needle='// ---- Model Selector (chat bar, same popover pattern as thinking level) ----\nlet modelSelectorProfiles = [];'
s=s.replace(needle, '// ---- Model Selector (chat bar, same popover pattern as thinking level) ----', 1)
# Re-apply capability UI after selector profiles are loaded.
needle='  hint.textContent = active.provider + \' · \' + active.model;\n\n  modelSelectorProfiles.forEach'
replacement='  hint.textContent = active.provider + \' · \' + active.model;\n  applyThinkingLevelUI(currentThinkingLevel);\n\n  modelSelectorProfiles.forEach'
if needle in s:
    s=s.replace(needle,replacement,1)
p.write_text(s,encoding='utf-8')
print('fixed thinking initialization and refresh')
