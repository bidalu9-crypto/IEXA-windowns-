import os

ctx_ts = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\agent\ContextCompactor.ts'

with open(ctx_ts, 'r', encoding='utf-8') as f:
    content = f.read()

# Fix: the estimated flag should reflect whether the displayed number is from estimation,
# not just whether we've ever received an API receipt.
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
    };
  }"""

count = content.count(old)
print(f'Occurrences: {count}')
if count > 0:
    content = content.replace(old, new, 1)
    print('OK')
else:
    # Try with CRLF
    old_crlf = old.replace('\n', '\r\n')
    new_crlf = new.replace('\n', '\r\n')
    count2 = content.count(old_crlf)
    print(f'CRLF occurrences: {count2}')
    if count2 > 0:
        content = content.replace(old_crlf, new_crlf, 1)
        print('OK (CRLF)')
    else:
        print('FAIL')

with open(ctx_ts, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'New size: {len(content)}')