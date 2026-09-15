import os

ctx_ts = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\agent\ContextCompactor.ts'

with open(ctx_ts, 'r', encoding='utf-8') as f:
    content = f.read()

print(f'File size: {len(content)}')

# Find all occurrences of 'status'
for i, line in enumerate(content.split('\n')):
    if 'status' in line and ('(' in line or 'function' in line or '=>' in line):
        print(f'Line {i+1}: {line.strip()}')

# Find all occurrences of 'estimated'
print()
for i, line in enumerate(content.split('\n')):
    if 'estimated' in line.lower() and not line.strip().startswith('//') and not line.strip().startswith('const'):
        print(f'Line {i+1}: {line.rstrip()}')

# Find the lastReportedInputTokens line
print()
for i, line in enumerate(content.split('\n')):
    if 'lastReportedInputTokens === 0' in line:
        print(f'Line {i+1}: {line.rstrip()}')