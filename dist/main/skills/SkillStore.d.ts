export type SkillSource = 'file' | 'paste' | 'bundled' | 'session' | 'url';
export interface Skill {
    id: string;
    name: string;
    description: string;
    version: string;
    source: SkillSource;
    enabled: boolean;
    installedAt: number;
    updatedAt: number;
    useCount: number;
    body: string;
    /** Explicitly trusted application-level skill. */
    systemPrompt: boolean;
    /** Absolute path to SKILL.md on disk */
    skillPath: string;
    dirPath: string;
}
export declare class SkillStore {
    private skillsDir;
    private indexFile;
    private skills;
    private readonly validator;
    constructor(baseDir: string);
    getSkillsDir(): string;
    list(): Skill[];
    get(id: string): Skill | undefined;
    /** Absolute path the model should file_read */
    skillMdPath(id: string): string;
    reload(): void;
    /** Import from SKILL.md text content */
    importFromContent(content: string, source?: SkillSource): Skill;
    setEnabled(id: string, enabled: boolean): boolean;
    setSystemPrompt(id: string, value: boolean): boolean;
    delete(id: string): boolean;
    recordUse(id: string): void;
    /** If path points at a skill SKILL.md, return skill id */
    skillIdFromPath(filePath: string): string | null;
    /**
     * iOS-style progressive disclosure fragment for system prompt.
     * Only name + description + path — model file_reads SKILL.md for full body.
     */
    skillPromptFragment(): string | null;
    /**
     * Full bodies for explicitly trusted application-level skills. Ordinary
     * imported skills remain catalog-only and are loaded through file_read.
     */
    systemPromptFragment(): string | null;
    private loadIndex;
    private saveIndex;
}
export interface ParsedSkillMD {
    name: string;
    description: string;
    version: string;
    body: string;
    systemPrompt?: boolean;
}
export declare function parseSkillMd(content: string): ParsedSkillMD;
export declare function slugify(name: string): string;
/** Install a couple of built-in example skills if none exist */
export declare function ensureBundledSkills(store: SkillStore): void;
//# sourceMappingURL=SkillStore.d.ts.map