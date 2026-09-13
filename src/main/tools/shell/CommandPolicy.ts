import { IexaError } from '../../errors/IexaError';
export type CommandRisk = 'low' | 'medium' | 'high';

/** Arbitrary shells are a capability, not a command-name blacklist. */
export class CommandPolicy {
  classify(command: string): CommandRisk { this.assertAllowed(command); return 'high'; }
  assertAllowed(command: string): void {
    if (typeof command !== 'string' || !command.trim()) throw new IexaError('COMMAND_EMPTY', 'TOOL', 'Command is empty.');
    if (command.includes('\0')) throw new IexaError('COMMAND_INVALID', 'TOOL', 'Command contains a NUL character.');
  }
}
