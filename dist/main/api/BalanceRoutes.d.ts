/**
 * Read-only account balance for one model profile.
 *
 * The key never leaves this process: the route resolves the profile server-side
 * and returns only the normalised amount.
 */
import * as http from 'http';
import { URL } from 'url';
import { ModelProfileLike } from '../providers/BalanceTypes';
import { ProviderBalance } from '../providers/BalanceService';
export interface BalanceRoutesContext {
    findProfile(id: string): ModelProfileLike | null;
    fetchBalance(profile: ModelProfileLike, options: {
        force?: boolean;
    }): Promise<ProviderBalance>;
}
export declare function handleBalanceRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: BalanceRoutesContext): Promise<boolean>;
//# sourceMappingURL=BalanceRoutes.d.ts.map