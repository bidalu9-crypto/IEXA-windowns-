import os

ctx_ts = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\agent\ContextCompactor.ts'

with open(ctx_ts, 'r', encoding='utf-8') as f:
    content = f.read()

# The old logic is:
#   estimated: this.lastReportedInputTokens === 0,
# We want:
#   estimated: usedTokens >= estimatedTokens && estimatedTokens > this.lastReportedInputTokens

# Search for the exact line with trailing comma
old_line = "      estimated: this.lastReportedInputTokens === 0,"
new_line = "      estimated: usedTokens >= estimatedTokens && estimatedTokens > this.lastReportedInputTokens,"

# But we need to add a comment too. Let's add the comment and then change the line.
old_block = """    const usedTokens = Math.max(this.lastReportedInputTokens, estimatedTokens);
    const threshold = compactThresholdForWindow(this.contextWindow);
    const near = threshold > 0 && usedTokens >= threshold;
    return {
      contextWindow: this.contextWindow,
      usedTokens,
      estimated: this.lastReportedInputTokens === 0,
      compactThreshold: threshold,
      state: state === 'ok' && near ? 'near-limit' : state,
    };"""

new_block = """    const usedTokens = Math.max(this.lastReportedInputTokens, estimatedTokens);
    // The displayed number is from estimation when the local estimate is the value
    // we show (it's >= the API receipt, or we never received any API receipt).
    const estimated = usedTokens >= estimatedTokens && estimatedTokens > this.lastReportedInputTokens;
    const threshold = compactThresholdForWindow(this.contextWindow);
    const near = threshold > 0 && usedTokens >= threshold;
    return {
      contextWindow: this.contextWindow,
      usedTokens,
      estimated,
      compactThreshold: threshold,
      state: state === 'ok' && near ? 'near-limit' : state,
    };"""

# Try both LF and CRLF
for sep in ['\n', '\r\n']:
    old_c = old_block.replace('\n', sep)
    new_c = new_block.replace('\n', sep)
    count = content.count(old_c)
    print(f'CRLF={sep == chr(13)+chr(10)} occurrences: {count}')
    if count > 0:
        content = content.replace(old_c, new_c, 1)
        print('OK: estimated flag fixed')
        break

with open(ctx_ts, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'New size: {len(content)}')