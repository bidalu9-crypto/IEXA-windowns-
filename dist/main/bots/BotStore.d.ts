import { SoulFile } from '../agent/SoulStore';
export interface BotProfile {
    id: string;
    name: string;
    description: string;
    persona: string;
    memory: string;
    profileId: string;
    allowedTools: string[];
    created: number;
    updated: number;
}
export interface BotPackage {
    format: 'iexa-bot';
    version: 1;
    bot: Pick<BotProfile, 'name' | 'description' | 'persona' | 'allowedTools'> & {
        memory?: string;
    };
}
/** Parse data only. External plugins, archives and profile credentials are never imported. */
export declare function parseBotPackage(input: unknown): BotPackage;
/**
 * Conservative adapter for .botharness/bot.json (unversioned schema), verified at
 * BotHarness/DeepSeekBot commit 2a241b66459c07e9585f1cd45c7563bc70b15c78.
 * The descriptor contains display metadata, NOT a persona: upstream loads that
 * separately from SOUL.md / legacy PERSONA.md. Never infer instructions from bio/tags.
 */
export declare function convertTobsDescriptor(input: unknown): BotPackage;
/** Native iExA personas; no DSH process, protocol or credentials involved. */
export declare class BotStore {
    readonly root: string;
    private readonly store;
    constructor(root: string);
    list(): BotProfile[];
    get(id: string): BotProfile | undefined;
    save(input: Record<string, unknown>, id?: string): BotProfile;
    exportBot(id: string, includeMemory?: boolean): BotPackage;
    remove(id: string): void;
    memoryDir(id: string): string;
}
export declare function botSoul(base: SoulFile, bot: BotProfile): SoulFile;
//# sourceMappingURL=BotStore.d.ts.map