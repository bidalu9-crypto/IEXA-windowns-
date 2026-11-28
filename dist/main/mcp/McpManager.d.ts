export type McpTransport = 'stdio' | 'http';
export interface McpServerConfig {
    id: string;
    name: string;
    transport: McpTransport;
    command?: string;
    args?: string[];
    url?: string;
    enabled: boolean;
}
export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}
export interface McpResourceInfo {
    uri: string;
    name?: string;
    mimeType?: string;
}
export interface McpServerInfo extends McpServerConfig {
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    error?: string;
    tools: McpToolInfo[];
    resources: McpResourceInfo[];
    logs: string[];
}
/** Minimal MCP client supporting stdio JSON-RPC and JSON-over-HTTP servers. */
export declare class McpManager {
    private readonly configFile;
    private readonly configs;
    private readonly state;
    private readonly connections;
    constructor(configFile: string);
    list(): McpServerInfo[];
    add(input: Omit<McpServerConfig, 'id'>): McpServerInfo;
    remove(id: string): void;
    connect(id: string): Promise<McpServerInfo>;
    disconnect(id: string): McpServerInfo;
    callTool(id: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
    readResource(id: string, uri: string): Promise<unknown>;
    private request;
    private notify;
    private openStdio;
    private consume;
    private httpRequest;
    private getConfig;
    private info;
    private setState;
    private log;
    private validate;
    private load;
    private save;
}
//# sourceMappingURL=McpManager.d.ts.map