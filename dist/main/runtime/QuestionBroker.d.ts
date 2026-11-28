export interface QuestionOption {
    label: string;
    description?: string;
}
export interface AskQuestion {
    id: string;
    header?: string;
    question: string;
    options: QuestionOption[];
    multiSelect: boolean;
    allowFreeText: boolean;
    placeholder?: string;
    kind: 'choice' | 'text' | 'confirm';
}
export interface AskUserRequest {
    sessionId: string;
    toolCallId?: string;
    runId?: string;
    title: string;
    questions: AskQuestion[];
    signal?: AbortSignal;
}
export interface QuestionAnswer {
    id: string;
    selected: string[];
    freeText?: string;
    skipped?: boolean;
}
export interface PendingQuestion {
    id: string;
    sessionId: string;
    toolCallId?: string;
    runId?: string;
    title: string;
    questions: AskQuestion[];
    createdAt: number;
    expiresAt: number;
}
export type QuestionResolver = (request: AskUserRequest) => Promise<QuestionAnswer[] | null>;
type PendingListener = (pending: PendingQuestion) => void;
/** Bridges a runtime question wait to HTTP/SSE. */
export declare class QuestionBroker {
    private readonly timeoutMs;
    private readonly pending;
    private readonly listeners;
    constructor(timeoutMs?: number);
    request(request: AskUserRequest): Promise<QuestionAnswer[] | null>;
    subscribe(sessionId: string, listener: PendingListener): () => void;
    list(sessionId?: string): PendingQuestion[];
    resolve(id: string, answers: QuestionAnswer[] | null): boolean;
    cancelSession(sessionId: string): void;
}
export interface NormalizedAsk {
    title: string;
    questions: AskQuestion[];
}
/** Validate and shape raw ask_user tool arguments into a normalized card payload. */
export declare function normalizeAskUserArgs(args: Record<string, unknown>): NormalizedAsk;
/** Render the collected answers as the tool result text the model reads. */
export declare function formatQuestionAnswers(title: string, questions: AskQuestion[], answers: QuestionAnswer[]): string;
export {};
//# sourceMappingURL=QuestionBroker.d.ts.map