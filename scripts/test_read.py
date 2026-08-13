import sys

path = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\server.ts'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

print('File size:', len(content))
print('Lines:', content.count('\n'))
print()

# Find ModelProfile
idx = content.find('interface ModelProfile')
if idx >= 0:
    print('Found ModelProfile at', idx)
    print(repr(content[idx:idx+200]))
else:
    print('NOT FOUND')