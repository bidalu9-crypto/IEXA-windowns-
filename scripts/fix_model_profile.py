import os

sv = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\server.ts'
with open(sv, 'r', encoding='utf-8') as f:
    content = f.read()

# Find the exact ModelProfile block
idx = content.find('interface ModelProfile')
if idx >= 0:
    # Find the closing brace
    end = content.find('\n}', idx)
    if end < 0:
        end = content.find('}', idx)
    block = content[idx:end+2]
    print('Current block:')
    print(block)
    
    # Add maxOutputTokens if not present
    if 'maxOutputTokens' not in block:
        # Insert before the closing brace
        new_block = block[:-2] + '  /** API-reported max output tokens. */\n  maxOutputTokens?: number;\n}'
        content = content[:idx] + new_block + content[end+2:]
        print('OK: added maxOutputTokens')
    else:
        print('maxOutputTokens already present')

with open(sv, 'w', encoding='utf-8') as f:
    f.write(content)