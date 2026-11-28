import * as http from 'http';
import { URL } from 'url';
import { PluginManager } from '../plugins/PluginManager';
import { PluginMarket } from '../plugins/PluginMarket';
export interface PluginRouteContext {
    plugins: PluginManager;
    market: PluginMarket;
    skillsChanged: () => void;
}
export declare function handlePluginRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: PluginRouteContext, desktopAuthenticated: boolean): Promise<boolean>;
//# sourceMappingURL=PluginRoutes.d.ts.map