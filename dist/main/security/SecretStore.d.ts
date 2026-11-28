export interface SecretCodec {
    readonly id: string;
    encrypt(plaintext: Buffer): Buffer;
    decrypt(ciphertext: Buffer): Buffer;
}
export interface ProtectedSettingsStore {
    loadProtectedSettings<T>(filePath: string, fallback: () => T): T;
    saveProtectedSettings<T>(filePath: string, obj: T): void;
}
export declare function createPlatformSecretCodec(): SecretCodec;
/** Use a private store instance for injected codecs; no global test-mode bypass. */
export declare function createProtectedSettingsStore(injectedCodec?: SecretCodec): ProtectedSettingsStore;
export declare const loadProtectedSettings: <T>(filePath: string, fallback: () => T) => T;
export declare const saveProtectedSettings: <T>(filePath: string, obj: T) => void;
//# sourceMappingURL=SecretStore.d.ts.map