import os

server_ts = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\server.ts'

with open(server_ts, 'r', encoding='utf-8') as f:
    content = f.read()

# Pass contextWindow to AgentLoopConfig in getOrCreateAgent
old = """    onSkillWrite: (resolvedPath: string) => {
      // iOS: agent-created SKILL.md under skills/ → rescan registry
      const norm = path.resolve(resolvedPath).replace(/\\\\/g, '/').toLowerCase();
      const root = path.resolve(skillsDir).replace(/\\\\/g, '/').toLowerCase();
      if (norm.startsWith(root) && norm.endsWith('skill.md')) {
        skillStore.reload();
        console.log('[Skills] reloaded after agent write:', resolvedPath);
      }
    },
  };"""

new = """    onSkillWrite: (resolvedPath: string) => {
      // iOS: agent-created SKILL.md under skills/ → rescan registry
      const norm = path.resolve(resolvedPath).replace(/\\\\/g, '/').toLowerCase();
      const root = path.resolve(skillsDir).replace(/\\\\/g, '/').toLowerCase();
      if (norm.startsWith(root) && norm.endsWith('skill.md')) {
        skillStore.reload();
        console.log('[Skills] reloaded after agent write:', resolvedPath);
      }
    },
    contextWindow: profile.contextWindow,
  };"""

count = content.count(old)
print(f'getOrCreateAgent skillWrite occurrences: {count}')
if count > 0:
    content = content.replace(old, new, 1)
    print('OK: pass contextWindow to AgentLoopConfig')
else:
    print('FAIL: skillWrite block not found')

with open(server_ts, 'w', encoding='utf-8') as f:
    f.write(content)

print('Done')