import os

ctx_ts = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\agent\ContextCompactor.ts'

with open(ctx_ts, 'r', encoding='utf-8') as f:
    content = f.read()

# Search for the exact text around "estimated: this.lastReportedInputTokens === 0"
import re

# Find status() method
idx = content.find('status(history')
if idx >= 0:
    method_text = content[idx:idx+1000]
    # Find the estimated line
    est_idx = method_text.find('estimated:')
    if est_idx >= 0:
        print(f'Found estimated: at offset {est_idx}')
        # Show the exact characters
        print(repr(method_text[est_idx:est_idx+80]))
        
        # Now replace it
        old_line = method_text[est_idx:est_idx+80]
        print(f'Old line: {repr(old_line)}')
        
        # The pattern we want to replace: "      estimated: this.lastReportedInputTokens === 0,"
        old_pattern = "estimated: this.lastReportedInputTokens === 0,"
        new_pattern = "estimated: usedTokens >= estimatedTokens && estimatedTokens > this.lastReportedInputTokens,"
        
        if old_pattern in method_text:
            new_method = method_text.replace(old_pattern, new_pattern, 1)
            # Add a comment before the estimated line
            comment = "    // 'estimated' = true when the displayed number came from local estimation.\n    "
            # Find the estimated line in the new method and add comment before it
            new_est_idx = new_method.find('estimated: usedTokens >=')
            if new_est_idx >= 0:
                # Find the beginning of this line (go back to column 4 or start of line)
                line_start = new_method.rfind('\n', 0, new_est_idx)
                if line_start >= 0:
                    new_method = new_method[:line_start+1] + comment + new_method[line_start+1:]
            
            content = content[:idx] + new_method + content[idx+len(method_text):]
            print('OK: estimated flag fixed')
        else:
            print('FAIL: old pattern not found')
    else:
        print('FAIL: estimated: not found in status()')
else:
    print('FAIL: status() not found')

with open(ctx_ts, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'New size: {len(content)}')