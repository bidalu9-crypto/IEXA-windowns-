import os

ag = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\agent\AgentLoop.ts'

with open(ag, 'r', encoding='utf-8') as f:
    content = f.read()

print(f'AgentLoop.ts size: {len(content)}')

# 1. Add contextWindow to AgentLoopConfig
old1 = "  /** Absolute skills directory for authoring instructions. */\n  skillsDir?: string | null;"
new1 = "  /** Absolute skills directory for authoring instructions. */\n  skillsDir?: string | null;\n  /** API-reported context window (from /v1/models), overrides model-name guessing. */\n  contextWindow?: number;"
count = content.count(old1)
print(f'AgentLoopConfig skillsDir occurrences: {count}')
if count > 0:
    content = content.replace(old1, new1, 1)
    print('OK: AgentLoopConfig contextWindow')
else:
    print('FAIL: AgentLoopConfig skillsDir')

# 2. Update contextWindow usage in run() to prefer config
old2 = "    const contextWindow = contextWindowForModel(this.config.provider.model, this.config.provider.name);"
new2 = "    const contextWindow = this.config.contextWindow != null\n      ? this.config.contextWindow\n      : contextWindowForModel(this.config.provider.model, this.config.provider.name);"
count2 = content.count(old2)
print(f'run() contextWindow occurrences: {count2}')
if count2 > 0:
    content = content.replace(old2, new2, 1)
    print('OK: run() contextWindow')
else:
    print('FAIL: run() contextWindow')

with open(ag, 'w', encoding='utf-8') as f:
    f.write(content)

print(f'New size: {len(content)}')
print('Done')