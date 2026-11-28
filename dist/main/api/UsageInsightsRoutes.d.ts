import * as http from 'http';
import { URL } from 'url';
import { TokenPrice } from '../usage/UsageInsights';
export interface UsageRouteContext {
    workspaceDir: string;
    listProfiles(): Array<{
        id: string;
        provider: string;
        model: string;
        tokenPrice?: TokenPrice;
    }>;
    listSessions(): Array<{
        id: string;
        title: string;
        modelBinding?: {
            profileId?: string;
            provider?: string;
            model?: string;
        };
    }>;
}
export declare function handleUsageInsightsRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: UsageRouteContext): Promise<boolean>;
//# sourceMappingURL=UsageInsightsRoutes.d.ts.map