import { ToolExecutionResult } from '../../providers/types';

export type DesktopAdapterCapability =
  | 'background_capture'
  | 'semantic_controls'
  | 'invoke'
  | 'value'
  | 'background_input'
  | 'verification';

export interface DesktopAdapterContext {
  app?: string;
  process?: string;
  windowTitle?: string;
  handle?: number;
  pid?: number;
}

export interface DesktopBackgroundAdapter {
  readonly id: string;
  readonly priority: number;
  readonly capabilities: readonly DesktopAdapterCapability[];
  matches(context: DesktopAdapterContext): boolean;
  /** Optional preflight. It must never activate or focus a window. */
  preflight?(context: DesktopAdapterContext, action: string): { allowed: boolean; reason?: string };
  /** Optional protocol enrichment; adapters may only add non-sensitive metadata. */
  enrich?(result: ToolExecutionResult, context: DesktopAdapterContext): ToolExecutionResult;
}

class GenericDesktopAdapter implements DesktopBackgroundAdapter {
  readonly id = 'generic-uia';
  readonly priority = 0;
  readonly capabilities = ['background_capture', 'semantic_controls', 'invoke', 'value', 'verification'] as const;
  matches(): boolean { return true; }
  preflight(_context: DesktopAdapterContext, action: string) {
    const allowed = new Set(['list_windows', 'observe', 'bind_window', 'session_state', 'find_element', 'click_element', 'type_element', 'frame']);
    return !allowed.has(action)
      ? { allowed: false, reason: 'Generic background adapter only permits UIA Invoke/Value; physical input requires foreground ownership.' }
      : { allowed: true };
  }
}

/**
 * Application adapters are deliberately opt-in. A missing adapter is not a
 * reason to guess with OCR/coordinates: the generic adapter fails closed for
 * background input and preserves the user's foreground window.
 */
export class DesktopAdapterRegistry {
  private readonly adapters: DesktopBackgroundAdapter[] = [new GenericDesktopAdapter()];
  register(adapter: DesktopBackgroundAdapter): void {
    if (this.adapters.some(existing => existing.id === adapter.id)) throw new Error(`Desktop adapter already registered: ${adapter.id}`);
    this.adapters.push(adapter);
    this.adapters.sort((a, b) => b.priority - a.priority);
  }
  resolve(context: DesktopAdapterContext): DesktopBackgroundAdapter {
    return this.adapters.find(adapter => adapter.matches(context)) || this.adapters[this.adapters.length - 1];
  }
  describe(context: DesktopAdapterContext) {
    const adapter = this.resolve(context);
    return { id: adapter.id, capabilities: [...adapter.capabilities] };
  }
}

export const desktopAdapterRegistry = new DesktopAdapterRegistry();
