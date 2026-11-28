import { AgentToolDefinition, AgentToolParam, ToolExecutionResult } from '../providers/types';
export interface PluginToolManifest {
    name: string;
    description: string;
    parameters?: Record<string, AgentToolParam>;
    required?: string[];
    propertyOrdering?: string[];
}
export interface PluginPanelManifest {
    id: string;
    title: string;
    entry: string;
}
export interface PluginManifest {
    apiVersion?: 1 | 2;
    contributions?: {
        panels: PluginPanelManifest[];
    };
    id: string;
    name: string;
    version: string;
    description: string;
    author?: string;
    main?: string;
    ui?: string;
    /**
     * Markdown rendered at the very top of the system prompt while the plugin is
     * enabled. `{{tool_protocol}}` expands to one line per live tool and
     * `{{tool_count}}` to that count, so the table cannot drift from the registry
     * the model actually receives this turn.
     */
    system?: string;
    /** JSON object: toolName -> protocol line. Keys may also match by suffix. */
    protocols?: string;
    tools: PluginToolManifest[];
}
/** Result of compiling every enabled plugin's prompt contribution. */
export interface PluginSystemFragment {
    text: string;
    sources: Array<{
        id: string;
        chars: number;
    }>;
    problems: string[];
}
export interface InstalledPlugin extends PluginManifest {
    enabled: boolean;
    installedAt: number;
    directory: string;
    hasUI: boolean;
    uiURL?: string;
    error?: string;
    tools: Array<PluginToolManifest & {
        agentName: string;
    }>;
}
export interface PluginAgentBinding {
    pluginId: string;
    localName: string;
    definition: AgentToolDefinition;
}
export declare class PluginManager {
    private readonly workspaceDir;
    readonly pluginsDir: string;
    private readonly stateFile;
    private state;
    private readonly uiGrants;
    private readonly activeCalls;
    constructor(workspaceDir: string);
    list(): InstalledPlugin[];
    /**
     * Compile the prompt contribution of every enabled plugin.
     *
     * Read on every call rather than cached, so an edited file reaches the model
     * without a rebuild. A plugin without a `system` file contributes nothing; a
     * broken file is reported instead of silently swallowing the rest.
     */
    systemPromptFragment(budget?: number): PluginSystemFragment;
    /** toolName -> protocol line, merged from every enabled plugin. */
    toolProtocols(): Record<string, string>;
    install(sourcePath: string): InstalledPlugin;
    setEnabled(id: string, enabled: boolean): InstalledPlugin;
    reload(id: string): InstalledPlugin;
    remove(id: string): void;
    bindings(): PluginAgentBinding[];
    invoke(id: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult>;
    resolveUiAsset(id: string, relativePath?: string, panelId?: string): {
        path: string;
        html: boolean;
    };
    createUIGrant(id: string, panelId?: string): {
        token: string;
        url: string;
        expiresAt: number;
    };
    revokeUIGrant(id: string, token: string): void;
    resolveGrantedAsset(token: string, relative: string): {
        path: string;
        html: boolean;
        sdk?: boolean;
    };
    readUIState(id: string): {
        revision: number;
        value: unknown;
    };
    writeUIState(id: string, revision: number, value: unknown): {
        revision: number;
        value: unknown;
    };
    private cancelCalls;
    private validateArguments;
    private get;
    private pluginDirectory;
    private readManifest;
    private validateManifest;
    private validateParameters;
    private validateParameter;
    private toInstalled;
    private agentToolName;
    private resolveInside;
    private validatePackageSize;
    private runPlugin;
    private loadState;
    private saveState;
}
//# sourceMappingURL=PluginManager.d.ts.map