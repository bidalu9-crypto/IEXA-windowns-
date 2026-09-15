import os

app_js = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\renderer\app.js'
with open(app_js, 'r', encoding='utf-8') as f:
    content = f.read()

print(f'File size: {len(content)}')
print(f'data.models.length: {content.count("data.models.length")}')

if 'data.models.length' in content:
    content = content.replace('data.models.length', 'modelList.length', 1)
    print('Fixed')
    with open(app_js, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'New size: {len(content)}')
else:
    print('Already correct')