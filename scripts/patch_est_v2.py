import os

ctx_ts = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\agent\ContextCompactor.ts'

with open(ctx_ts, 'r', encoding='utf-8') as f:
    content = f.read()

# Find the estimated line and check its current state
import re
# Find status() method
idx = content.find('status(history')
if idx >= 0:
    # Find the estimated assignment
    est_line = content.find('estimated:', idx)
    if est_line >= 0:
        print(f'Found estimated: at offset {est_line}')
        print(repr(content[est_line:est_line+100]))
        # Check if already fixed
        if 'usedTokens >= estimatedTokens' in content[est_line:est_line+200]:
            print('ALREADY FIXED')
        elif 'lastReportedInputTokens === 0' in content[est_line:est_line+200]:
            print('NEEDS FIX')
            # Replace the line
            old_text = "      estimated: this.lastReportedInputTokens === 0,"
            new_text = "      estimated: usedTokens >= estimatedTokens && estimatedTokens > this.lastReportedInputTokens,"
            count = content.count(old_text)
            print(f'Found {count} occurrences of old text')
            if count > 0:
                # Insert comment before the line
                comment = "      // The label shows '模型实测' only when the displayed number came from the API.\n      "
                line_start = content.rfind('\n', 0, content.find(old_text)) + 1
                content = content[:line_start] + comment + content[line_start:]
                # Replace (search again after insert)
                content = content.replace(old_text, new_text, 1)
                print('OK: fixed')
            else:
                # Try with different indentation
                old_text2 = "estimated: this.lastReportedInputTokens === 0,"
                count2 = content.count(old_text2)
                print(f'Found {count2} occurrences of variant')
                if count2 > 0:
                    content = content.replace(old_text2, "estimated: usedTokens >= estimatedTokens && estimatedTokens > this.lastReportedInputTokens,", 1)
                    print('OK: fixed (variant)')
else:
    print('FAIL: status() not found')

with open(ctx_ts, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'New size: {len(content)}')