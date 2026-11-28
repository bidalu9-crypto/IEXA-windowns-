export interface PetConfig {
    /** Pet window is on screen. */
    visible: boolean;
    /** 0.5–2, multiplies the sprite's natural pixel size. */
    scale: number;
    /** Keep the pet above other windows. */
    alwaysOnTop: boolean;
    /** Drift to a new spot every so often. */
    wander: boolean;
    /** Soft drop shadow under the sprite. */
    shadow: boolean;
    /** Speech bubble on click. */
    reactions: boolean;
}
export interface PetSnapshot {
    hasSprite: boolean;
    spriteVersion: string;
    width: number;
    height: number;
    config: PetConfig;
}
export declare function normalizePetConfig(raw: unknown): PetConfig;
export declare class PetStore {
    private readonly dir;
    private readonly configPath;
    private readonly spritePath;
    private config;
    /** Bumped on every write: two replacements inside one millisecond must still
     *  produce a new URL, or the window keeps the cached image. */
    private writeSeq;
    constructor(dir: string);
    private load;
    private save;
    hasSprite(): boolean;
    spritePathname(): string;
    spriteSize(): {
        width: number;
        height: number;
    };
    /** Content stamp so the renderer can cache-bust without polling the file. */
    spriteVersion(): string;
    getConfig(): PetConfig;
    snapshot(): PetSnapshot;
    /** Replace the sprite. The caller already validated it is a PNG. */
    writeSprite(bytes: Buffer): {
        width: number;
        height: number;
    };
    updateConfig(patch: unknown): PetConfig;
    /** Remove the sprite and hide the pet; settings are kept. */
    clearSprite(): void;
}
//# sourceMappingURL=PetStore.d.ts.map