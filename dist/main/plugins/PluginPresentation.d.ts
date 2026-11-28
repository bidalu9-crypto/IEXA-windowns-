/** Host-owned, bounded data only. No plugin HTML or executable renderer is persisted. */
export interface PluginCard {
    version: 1;
    title: string;
    description?: string;
    fields?: Array<{
        label: string;
        value: string;
    }>;
    table?: {
        columns: string[];
        rows: string[][];
    };
}
export interface PluginPresentation {
    pluginId: string;
    pluginName: string;
    tool: string;
    card: PluginCard;
}
export declare function validatePluginCard(value: unknown): PluginCard;
//# sourceMappingURL=PluginPresentation.d.ts.map