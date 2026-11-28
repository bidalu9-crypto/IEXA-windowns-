import { ProviderConfig } from '../providers/types';
export interface VisionProfile extends ProviderConfig {
    id: string;
    displayName: string;
}
export declare class VisionFallback {
    describe(profile: VisionProfile, image: Buffer, mimeType: string, question?: string): Promise<string>;
}
//# sourceMappingURL=VisionFallback.d.ts.map