import os

ctx_ts = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\agent\ContextCompactor.ts'

with open(ctx_ts, 'r', encoding='utf-8') as f:
    content = f.read()

# Find and fix the estimated flag in status() method
# Look for the exact text: "estimated: this.lastReportedInputTokens === 0,"
target = "estimated: this.lastReportedInputTokens === 0,"
replacement = "estimated: usedTokens >= estimatedTokens && estimatedTokens > this.lastReportedInputTokens,"

count = content.count(target)
print(f'Found target: {count} occurrences')

if count > 0:
    # Also add a comment line before it
    comment_line = "    // The label shows '模型实测' only when the displayed number actually came from the API.\n    "
    # Find the line and add comment before it
    idx = content.find(target)
    # Go back to find line start (after the last newline before this line)
    line_start = content.rfind('\n', 0, idx) + 1
    if line_start > 0:
        # Insert comment at the beginning of this line
        content = content[:line_start] + comment_line + content[line_start:]
        # Now replace the estimated line
        content = content.replace(target, replacement, 1)
        print('OK: estimated flag fixed with comment')
    else:
        content = content.replace(target, replacement, 1)
        print('OK: estimated flag fixed (no comment)')
else:
    print('FAIL: target not found')
    # Check what's actually there
    idx = content.find('estimated:')
    if idx >= 0:
        print(repr(content[idx:idx+120]))

with open(ctx_ts, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'New size: {len(content)}')