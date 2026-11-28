import { ModelProfileLike } from './BalanceTypes';
export interface ProviderBalance {
    status: 'ok' | 'unsupported' | 'error';
    currency?: string;
    remaining?: number;
    used?: number;
    total?: number;
    granted?: number;
    toppedUp?: number;
    source?: string;
    message?: string;
    updatedAt: number;
}
/** Resolve a balance for one profile. Never throws; failures become a status. */
export declare function fetchProviderBalance(profile: ModelProfileLike, options?: {
    force?: boolean;
}): Promise<ProviderBalance>;
/** Only for tests; the cache is process-local. */
export declare function clearBalanceCache(): void;
//# sourceMappingURL=BalanceService.d.ts.map