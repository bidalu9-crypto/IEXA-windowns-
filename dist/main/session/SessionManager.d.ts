export declare class SessionManager<T> {
    private readonly root;
    constructor(root: string);
    private file;
    load(id: string): Promise<T | null>;
    save(id: string, value: T): Promise<void>;
    loadSync(id: string): T | null;
    saveSync(id: string, value: T): void;
    deleteSync(id: string): void;
}
//# sourceMappingURL=SessionManager.d.ts.map