import { ProjectScope } from '../context/ProjectScopeStore';
import { SoulFile } from './SoulStore';
import { AgentToolDefinition } from '../providers/types';
export interface SystemPromptContext {
    projectScope?: ProjectScope | null;
    /** Bounded project guidance with source paths, scopes and hashes. */
    projectInstructions?: string;
    memoryEnabled?: boolean;
    /** Absolute path of the opened project (tool cwd). */
    workspaceDir?: string;
    /** Display name of the project folder. */
    projectName?: string | null;
    /** True when user explicitly opened a project folder. */
    hasProject?: boolean;
    /** iOS-style skill catalog fragment (progressive disclosure). */
    skillFragment?: string | null;
    /** Full body of explicitly trusted application-level skills. */
    systemSkillFragment?: string | null;
    /**
     * Highest-priority block contributed by enabled plugins. Rendered as the
     * first thing inside the `<system>` envelope, above every built-in section.
     */
    pluginSystemFragment?: string | null;
    /** toolName -> protocol line, merged from enabled plugins. */
    pluginProtocols?: Record<string, string> | null;
    /** Absolute path where skills are stored (…/workspace/skills). */
    skillsDir?: string | null;
    /** Persistent SOUL.md identity and personality for this request envelope. */
    soul?: SoulFile | null;
    /** Server exposes shell_session / job_* / goal; describe them in the tool list. */
    sessionTools?: boolean;
    /**
     * The exact tool set sent to the provider this turn. When present, the prompt
     * carries a generated quick-reference so the names can never drift from the
     * registry. Omitting it keeps the legacy hand-written list (unit tests and
     * callers that build a prompt before a runtime exists).
     */
    tools?: AgentToolDefinition[];
}
export declare function buildSystemPrompt(ctx?: SystemPromptContext | boolean): string;
//# sourceMappingURL=SystemPrompt.d.ts.map