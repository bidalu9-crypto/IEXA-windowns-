import { IexaError } from '../errors/IexaError';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

export class LoopDetector {
  private recent: string[] = [];
  constructor(private readonly maxRepeat = 3, private readonly windowSize = 12) {
    if (!Number.isSafeInteger(maxRepeat) || maxRepeat < 1 || !Number.isSafeInteger(windowSize) || windowSize < maxRepeat + 1) {
      throw new IexaError('LOOP_CONFIG', 'CONFIG', 'Loop detector limits are invalid.');
    }
  }
  reset(): void { this.recent = []; }
  record(name: string, args: Record<string, unknown>): void {
    const key = `${name}:${JSON.stringify(canonical(args))}`;
    this.recent.push(key);
    if (this.recent.length > this.windowSize) this.recent.shift();
    if (this.recent.filter((item) => item === key).length > this.maxRepeat) {
      throw new IexaError('LOOP_DETECTED', 'RUNTIME', `检测到工具 ${name} 重复调用，任务已停止。`);
    }
  }
}
