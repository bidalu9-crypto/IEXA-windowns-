import os

ctx_ts = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\agent\ContextCompactor.ts'

with open(ctx_ts, 'r', encoding='utf-8') as f:
    content = f.read()

print(f'File size: {len(content)}')

# Find the status() method and check the estimated line
idx = content.find('estimated: this.lastReportedInputTokens === 0')
if idx >= 0:
    print(f'Found old estimated line at char {idx}')
    # Show surrounding context
    print(repr(content[idx-200:idx+200]))
else:
    print('Old estimated line NOT FOUND')
    # Check if it was already changed
    idx2 = content.find('estimated:')
    if idx2 >= 0:
        print(f'Found estimated: at char {idx2}')
        print(repr(content[idx2-100:idx2+200]))