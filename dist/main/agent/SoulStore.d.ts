export interface SoulMetadata {
    name: string;
    style: string;
    lang: string;
}
export interface SoulFile {
    metadata: SoulMetadata;
    body: string;
}
export interface SoulLimitCheck {
    count: number;
    /** null means no application-level personality body cap. */
    limit: null;
    isOverLimit: boolean;
}
export declare const DEFAULT_SOUL: SoulFile;
export declare function cloneDefaultSoul(): SoulFile;
/**
 * SOUL.md deliberately uses a small YAML-frontmatter subset. This parser is
 * tolerant of hand-edited files: malformed or missing frontmatter simply
 * makes the complete file a personality body with default metadata.
 */
export declare function parseSoulMarkdown(source: string): SoulFile;
export declare function serializeSoulMarkdown(file: SoulFile): string;
/** Count CJK graphemes individually and other language text by word. */
export declare function soulTokenCount(text: string): number;
export declare function checkSoulBodyLimit(body: string): SoulLimitCheck;
export declare function normalizeSoulMetadata(value: Partial<SoulMetadata> | undefined | null): SoulMetadata;
export declare class SoulStore {
    readonly filePath: string;
    constructor(memoryDir: string);
    ensureExists(): SoulFile;
    load(): SoulFile;
    save(value: SoulFile): SoulFile;
    restoreDefault(): SoulFile;
}
/** Render the app-owned identity sentence and optional user-authored voice. */
export declare function buildSoulPromptSection(file: SoulFile | undefined | null): string;
//# sourceMappingURL=SoulStore.d.ts.map