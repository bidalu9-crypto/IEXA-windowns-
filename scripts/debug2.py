import os

ctx_ts = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\agent\ContextCompactor.ts'

with open(ctx_ts, 'r', encoding='utf-8') as f:
    content = f.read()

# Find status method and dump surrounding content
idx = content.find('status(history')
if idx >= 0:
    print(repr(content[idx:idx+800]))
else:
    print('status() method not found!')
    # Search for 'status' 
    for line_start in range(len(content)):
        if content[line_start:line_start+6] == 'status':
            print(f'status at {line_start}')
            print(repr(content[line_start:line_start+100]))