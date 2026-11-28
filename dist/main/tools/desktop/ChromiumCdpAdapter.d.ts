import { ToolExecutionResult } from '../../providers/types';
/** A DOM automation backend, not a universal no-focus guarantee: page handlers may
 * open windows or request focus. Business and foreground oracles remain separate. */
export declare class ChromiumCdpAdapter {
    private readonly endpoint;
    private socket?;
    private sequence;
    private pending;
    private target?;
    private snapshot?;
    private uncertain;
    private closed;
    constructor(endpoint: string);
    close(): void;
    private invalidate;
    private rejectPending;
    private websocketUrl;
    private targets;
    private select;
    private connect;
    private command;
    private value;
    private call;
    private requireSnapshot;
    private valid;
    private observe;
    private keyboard;
    private rendererInput;
    execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult>;
    private result;
}
//# sourceMappingURL=ChromiumCdpAdapter.d.ts.map