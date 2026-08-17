import { IexaError } from '../../errors/IexaError';
export type CommandRisk = 'low' | 'medium' | 'high';
const elevated = /(^|[\s&|;])(format|diskpart|reg(?:\.exe)?|bcdedit|shutdown|sc(?:\.exe)?|netsh|cipher|takeown|icacls|rmdir|del|rd)(?:[\s&|;]|$)/i;
export class CommandPolicy {
  classify(command: string): CommandRisk { if (!command.trim()) throw new IexaError('COMMAND_EMPTY', 'TOOL', '命令不能为空。'); return elevated.test(command) ? 'high' : 'low'; }
  assertAllowed(command: string): void { if (/\b(powershell|cmd)\s+.*-enc(?:odedcommand)?\b/i.test(command)) throw new IexaError('COMMAND_ENCODED', 'SECURITY', '不允许执行编码的 Shell 命令。'); }
}
