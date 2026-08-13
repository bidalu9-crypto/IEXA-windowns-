import os

ctx_ts = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\agent\ContextCompactor.ts'

with open(ctx_ts, 'r', encoding='utf-8') as f:
    content = f.read()

# The current bug: "estimated: this.lastReportedInputTokens === 0,"
# means it's only 'estimated' if we NEVER got an API receipt.
# But even after getting an API receipt, the displayed number may still be
# from the local estimate (if the estimate is larger). Fix:
old = "      estimated: this.lastReportedInputTokens === 0,"
new = "      estimated: usedTokens >= estimatedTokens && estimatedTokens > this.lastReportedInputTokens,"

count = content.count(old)
print(f'Found: {count}')
if count > 0:
    # Add a comment line before it
    comment = "      // The label shows '模型实测' only when the displayed number actually came from the API.\n"
    idx = content.find(old)
    # Find line start
    line_start = content.rfind('\n', 0, idx) + 1
    content = content[:line_start] + comment + content[line_start:]
    # Now replace (idx shifted by comment length, so search again)
    idx2 = content.find(old)
    content = content[:idx2] + new + content[idx2+len(old):]
    print('OK: estimated flag fixed')
else:
    print('FAIL: target not found')
    # Debug
    idx = content.find('estimated:')
    if idx >= 0:
        print(repr(content[idx:idx+120]))

with open(ctx_ts, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'New size: {len(content)}')