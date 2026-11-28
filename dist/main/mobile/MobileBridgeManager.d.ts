export type MobileCapability = 'chat' | 'files' | 'full';
export interface MobileBridgeDevice {
    id: string;
    name: string;
    capability: MobileCapability;
    createdAt: number;
    lastActiveAt: number;
}
export declare class MobileBridgeManager {
    private readonly store;
    private state;
    private pairTokens;
    private pairPin;
    private port;
    constructor(workspaceDir: string);
    setPort(port: number): void;
    isEnabled(): boolean;
    status(): {
        enabled: boolean;
        defaultCapability: MobileCapability;
        addresses: string[];
        port: number;
        devices: MobileBridgeDevice[];
    };
    configure(input: {
        enabled?: unknown;
        defaultCapability?: unknown;
    }): ReturnType<MobileBridgeManager['status']>;
    createPairToken(address?: string): {
        token: string;
        expiresAt: number;
        url: string;
    };
    /** Four digits, uniform, no leading-zero bias. Replaces any previous code. */
    createPairPin(): {
        code: string;
        expiresAt: number;
        ttlMs: number;
    };
    /** Whether a usable code exists, without ever revealing it. */
    pairPinState(): {
        active: boolean;
        expiresAt: number;
    };
    /** Null on success, otherwise the reason so the phone can show it. */
    pairWithPin(code: string, name: string): {
        device: MobileBridgeDevice;
        sessionToken: string;
    } | {
        error: string;
    };
    pair(token: string, name: string): {
        device: MobileBridgeDevice;
        sessionToken: string;
    } | null;
    /** Shared tail of both pairing paths: mint a session and store the device. */
    private registerDevice;
    /** Forget the current code, e.g. when the desktop panel regenerates it. */
    revokePairPin(): void;
    authenticate(sessionToken: string): MobileBridgeDevice | null;
    devices(): MobileBridgeDevice[];
    revoke(id: string): boolean;
    setCapability(id: string, capability: unknown): MobileBridgeDevice | null;
    revokeAll(): void;
    private publicDevice;
    private hash;
    private secureEqual;
    private pruneTokens;
    private prunePin;
    private save;
}
//# sourceMappingURL=MobileBridgeManager.d.ts.map