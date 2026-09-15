import os

app_js = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\renderer\app.js'

with open(app_js, 'r', encoding='utf-8') as f:
    content = f.read()

print(f'File size: {len(content)}')

# Debug: find the data.models.map pattern
idx = content.find('data.models')
if idx >= 0:
    chunk = content[idx:idx+300]
    # Write to file instead of printing
    with open(r'C:\Users\Administrator\Desktop\iEXA-WIN\scripts\debug_app.txt', 'w', encoding='utf-8') as f:
        f.write(repr(chunk))
    print('Written to debug_app.txt')
else:
    print('data.models not found')

# Also check if the file was already patched
idx2 = content.find('modelList')
if idx2 >= 0:
    print(f'modelList found at {idx2}')