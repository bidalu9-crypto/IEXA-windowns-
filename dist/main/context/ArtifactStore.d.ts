export interface ArtifactRef {
    id: string;
    path: string;
    size: number;
    createdAt: number;
}
export declare class ArtifactStore {
    private readonly root;
    constructor(root: string);
    put(content: string, extension?: string): Promise<ArtifactRef>;
}
//# sourceMappingURL=ArtifactStore.d.ts.map