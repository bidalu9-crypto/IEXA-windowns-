from pathlib import Path
p = Path('src/renderer/index.html')
s = p.read_text(encoding='utf-8')
old = '''    <nav class="sidebar-nav">
      <button class="nav-btn active" data-view="chat">💬 对话</button>
      <button class="nav-btn" data-view="settings">⚙️ 模型</button>
      <button class="nav-btn" data-view="skills">🧩 Skills</button>
      <button class="nav-btn" data-view="appearance">🎨 外观</button>
      <button class="nav-btn" data-view="sync">🔄 同步</button>
      <button class="nav-btn" data-view="about">ℹ️ 关于</button>
    </nav>'''
new = '''    <nav class="sidebar-nav">
      <button class="nav-btn active" data-view="chat">💬 对话</button>
      <button class="nav-btn" data-view="appearance">🎨 外观</button>
      <button class="nav-btn" data-view="skills">🧩 技能</button>
      <button class="nav-btn" data-view="settings">⚙️ 配置</button>
      <button class="nav-btn" data-view="sync">🔄 设备</button>
      <button class="nav-btn" data-view="about">ℹ️ 关于</button>
    </nav>'''
if old not in s:
    raise SystemExit('navigation block not found')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('sidebar navigation updated')
