import { PluginManager, InstalledPlugin } from './PluginManager';
export interface MarketEntry {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    tags?: string[];
    homepage?: string;
    download: string;
    sha256?: string;
}
export declare class PluginMarket {
    search(indexUrl: string, query: string): Promise<{
        title: string;
        items: MarketEntry[];
    }>;
    install(indexUrl: string, id: string, plugins: PluginManager): Promise<InstalledPlugin>;
    private extract;
    private findManifestDir;
}
//# sourceMappingURL=PluginMarket.d.ts.map