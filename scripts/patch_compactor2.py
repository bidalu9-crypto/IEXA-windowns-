import os

ctx_ts = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\agent\ContextCompactor.ts'

with open(ctx_ts, 'r', encoding='utf-8') as f:
    content = f.read()

# Fix: the estimated flag should reflect whether the DISPLAYED number is from estimation.
# Old logic: estimated = (lastReportedInputTokens === 0) -- wrong, because even after
# one API receipt, the displayed usedTokens may still be the local estimate (bigger).
old = """  status(history: AgentMessage[], state: ContextStatus['state'] = 'ok'): ContextStatus {
    const estimatedTokens = estimateMessageTokens(history) + Math.ceil(this.systemPrompt.length / 3.5);
    // Provider usage is the best baseline, but new tool results appended since
    // that response are not included in it. Never let a stale API receipt
    // under-report the next request's actual history.
    const usedTokens = Math.max(this.lastReportedInputTokens, estimatedTokens);
    const threshold = compactThresholdForWindow(this.contextWindow);
    const near = threshold > 0 && usedTokens >= threshold;
    return {
      contextWindow: this.contextWindow,
      usedTokens,
      estimated: this.lastReportedInputTokens === 0,
      compactThreshold: threshold,
      state: state === 'ok' && near ? 'near-limit' : state,
    };
  }"""

new = """  status(history: AgentMessage[], state: ContextStatus['state'] = 'ok'): ContextStatus {
    const estimatedTokens = estimateMessageTokens(history) + Math.ceil(this.systemPrompt.length / 3.5);
    // Provider usage is the best baseline, but new tool results appended since
    // that response are not included in it. Never let a stale API receipt
    // under-report the next request's actual history.
    const usedTokens = Math.max(this.lastReportedInputTokens, estimatedTokens);
    // 'estimated' = the displayed number actually came from local character counting
    // (not from the API). This is true when the estimate is the larger value we show,
    // or when we never received any API usage receipt yet.
    const estimated = usedTokens >= estimatedTokens && estimatedTokens > this.lastReportedInputTokens;
    const threshold = compactThresholdForWindow(this.contextWindow);
    const near = threshold > 0 && usedTokens >= threshold;
    return {
      contextWindow: this.contextWindow,
      usedTokens,
      estimated,
      compactThreshold: threshold,
      state: state === 'ok' && near ? 'near-limit' : state,
    };
  }"""

count = content.count(old)
print(f'status() occurrences: {count}')
if count > 0:
    content = content.replace(old, new, 1)
    print('OK: estimated flag fixed')
else:
    print('FAIL: status() block not found')

with open(ctx_ts, 'w', encoding='utf-8') as f:
    f.write(content)

print(f'New size: {len(content)}')
print('Done')