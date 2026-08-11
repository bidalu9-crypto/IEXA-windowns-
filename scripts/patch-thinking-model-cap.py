from pathlib import Path
p=Path('src/renderer/app.js')
s=p.read_text(encoding='utf-8')
start=s.index('function applyThinkingLevelUI(level) {')
end=s.index('\n}\n\nfunction setThinkingMenuOpen',start)+2
new='''const THINKING_LEVEL_ORDER = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function thinkingMaxLevelForModel(profile) {
  if (!profile || !profile.model) return 'xhigh';
  const model = String(profile.model).toLowerCase().replace(/\\./g, '-');
  const provider = String(profile.provider || '').toLowerCase();
  if (/mimo|agnes|seed-|bytedance-seed|doubao/.test(model)) return 'high';
  if (/claude-opus-4/.test(model)) return 'max';
  if (/gpt-5-5/.test(model)) return 'xhigh';
  if (/gpt-5-6/.test(model)) return 'max';
  if (/o[1-9]|gpt-5|deepseek|reason|thinking|\\br1\\b|qwq|grok/.test(model) || provider === 'deepseek' || provider === 'xai') return 'xhigh';
  return 'off';
}

function applyThinkingLevelUI(level) {
  currentThinkingLevel = normalizeThinkingLevel(level);
  const activeProfile = modelSelectorProfiles.find((p) => p.id === activeProfileId);
  const maxLevel = thinkingMaxLevelForModel(activeProfile);
  const maxIndex = THINKING_LEVEL_ORDER.indexOf(maxLevel);
  const currentIndex = THINKING_LEVEL_ORDER.indexOf(currentThinkingLevel);
  if (currentIndex > maxIndex) currentThinkingLevel = maxLevel;
  const btn = document.getElementById('thinkingLevelBtn');
  const label = document.getElementById('thinkingLevelLabel');
  const menu = document.getElementById('thinkingLevelMenu');
  if (label) label.textContent = THINKING_LEVELS[currentThinkingLevel].label;
  if (btn) {
    btn.dataset.level = currentThinkingLevel;
    btn.title = '思考档位：' + THINKING_LEVELS[currentThinkingLevel].label;
    btn.disabled = maxLevel === 'off';
  }
  if (menu) {
    menu.querySelectorAll('.thinking-level-option').forEach((el) => {
      const visible = THINKING_LEVEL_ORDER.indexOf(el.dataset.level) <= maxIndex;
      el.hidden = !visible;
      el.classList.toggle('is-active', el.dataset.level === currentThinkingLevel);
      el.setAttribute('aria-selected', String(el.dataset.level === currentThinkingLevel));
    });
  }
}'''
p.write_text(s[:start]+new+s[end:],encoding='utf-8')
print('patched model capability filtering')
