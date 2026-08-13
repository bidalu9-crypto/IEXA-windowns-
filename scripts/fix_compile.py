import os

# Fix 1: AgentLoop.ts line 60 syntax error
ag = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\agent\AgentLoop.ts'
with open(ag, 'r', encoding='utf-8') as f:
    content = f.read()

old = "  private compactor: ContextCompactor | null = null;'';"
new = "  private compactor: ContextCompactor | null = null;"
count = content.count(old)
print(f'Fix 1 occurrences: {count}')
if count > 0:
    content = content.replace(old, new, 1)
    print('OK: fixed')
with open(ag, 'w', encoding='utf-8') as f:
    f.write(content)

# Fix 2: server.ts ModelProfile add maxOutputTokens
sv = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\server.ts'
with open(sv, 'r', encoding='utf-8') as f:
    content = f.read()

old2 = """interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  /** API-reported context window from /v1/models (if available). */
  contextWindow?: number;
}"""
new2 = """interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  /** API-reported context window from /v1/models (if available). */
  contextWindow?: number;
  /** API-reported max output tokens from /v1/models (if available). */
  maxOutputTokens?: number;
}"""
count2 = content.count(old2)
print(f'Fix 2 occurrences: {count2}')
if count2 > 0:
    content = content.replace(old2, new2, 1)
    print('OK: fixed')
with open(sv, 'w', encoding='utf-8') as f:
    f.write(content)

print('Done')