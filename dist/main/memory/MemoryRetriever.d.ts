import { MemoryHit, MemorySearchOptions } from './MemoryTypes';
/** Ranks the existing Markdown memory log without injecting the whole directory. */
export declare class MemoryRetriever {
    private readonly root;
    constructor(root: string);
    search(query?: string, options?: MemorySearchOptions): Promise<MemoryHit[]>;
}
//# sourceMappingURL=MemoryRetriever.d.ts.map