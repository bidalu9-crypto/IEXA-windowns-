import os

app_js = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\renderer\app.js'
with open(app_js, 'r', encoding='utf-8') as f:
    content = f.read()

print(f'File size: {len(content)}')

# Search for the exact string
target = 'data.models.length'
idx = content.find(target)
if idx >= 0:
    print(f'Found at char {idx}')
    print(repr(content[idx-50:idx+200]))
else:
    print('Not found')
    # Try finding just 'models.length'
    idx2 = content.find('models.length')
    if idx2 >= 0:
        print(f'models.length found at {idx2}')
        print(repr(content[idx2-100:idx2+200]))