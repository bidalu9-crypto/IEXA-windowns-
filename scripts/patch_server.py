import sys
import os

base = r'C:\Users\Administrator\Desktop\iEXA-WIN'
server_ts = os.path.join(base, 'src', 'main', 'server.ts')

with open(server_ts, 'r', encoding='utf-8') as f:
    content = f.read()

print(f'server.ts size: {len(content)}')

# 1. Add contextWindow to ModelProfile
old_profile = 'interface ModelProfile {\n  id: string;\n  name: string;\n  provider: string;\n  model: string;\n  apiKey: string;\n  baseURL?: string;\n}'
new_profile = 'interface ModelProfile {\n  id: string;\n  name: string;\n  provider: string;\n  model: string;\n  apiKey: string;\n  baseURL?: string;\n  /** API-reported context window from /v1/models (if available). */\n  contextWindow?: number;\n}'

count = content.count(old_profile)
print(f'old_profile occurrences: {count}')
if count > 0:
    content = content.replace(old_profile, new_profile, 1)
    print('Patched ModelProfile')
else:
    # Try with CRLF
    old_profile_crlf = old_profile.replace('\n', '\r\n')
    count2 = content.count(old_profile_crlf)
    print(f'old_profile CRLF occurrences: {count2}')
    if count2 > 0:
        content = content.replace(old_profile_crlf, new_profile.replace('\n', '\r\n'), 1)
        print('Patched ModelProfile (CRLF)')

with open(server_ts, 'w', encoding='utf-8') as f:
    f.write(content)

print('Done')