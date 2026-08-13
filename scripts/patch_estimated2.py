import os

ctx_ts = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\agent\ContextCompactor.ts'

with open(ctx_ts, 'r', encoding='utf-8') as f:
    content = f.read()

old = """  status(history: AgentMessage[], state: ContextStatus['state'] = 'ok'): ContextStatus {
    const estimatedTokens = estimateMessageTokens(history) + Math.ceil(this.systemPrompt.length / 3.5);
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
    // 'estimated' is true when the displayed number actually came from local
    // character counting (the estimate is the value we show), false when the
    // displayed number came from an API usage receipt.
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
print(f'Occurrences: {count}')
if count > 0:
    content = content.replace(old, new, 1)
    print('OK: estimated flag fixed')
else:
    print('FAIL: status() not found')

with open(ctx_ts, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'New size: {len(content)}')