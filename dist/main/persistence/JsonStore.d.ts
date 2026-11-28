/** Crash-tolerant JSON persistence with a last-known-good backup. */
export declare class JsonStore<T> {
    private readonly filePath;
    private readonly fallback;
    constructor(filePath: string, fallback: () => T);
    loadSync(): T;
    saveSync(value: T): void;
    save(value: T): Promise<void>;
    private read;
}
export declare function backupByLinkSync(filePath: string): void;
export declare function backupByLink(filePath: string): Promise<void>;
export declare function writeTextAtomic(filePath: string, content: string | Buffer, backup?: boolean): void;
//# sourceMappingURL=JsonStore.d.ts.map