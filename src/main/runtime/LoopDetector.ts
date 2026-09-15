import { IexaError } from '../errors/IexaError';

export class LoopDetector {
  private recent: string[] = [];
  constructor(private readonly maxRepeat = 3, private readonly windowSize = 12) {}
  reset(): void { this.recent = []; }
  record(name: string, args: Record<string, unknown>): void {
    const key = `${name}:${JSON.stringify(args)}`;
    this.recent.push(key);
    if (this.recent.length > this.windowSize) this.recent.shift();
    if (this.recent.filter((item) => item === key).length > this.maxRepeat) {
      throw new IexaError('LOOP_DETECTED', 'RUNTIME', `检测到工具 ${name} 重复调用，任务已停止。`);
    }
  }
}
