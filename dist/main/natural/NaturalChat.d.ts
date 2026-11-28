/**
 * Natural-chat pulse.
 *
 * A normal turn is request/response: the assistant speaks only when spoken to.
 * Natural chat keeps the conversation alive after the reply - it rolls a chance
 * on a fixed schedule and, when a roll hits, asks the host to produce one
 * unprompted line.
 *
 * The schedule is counted from the moment her first reply finished:
 *
 *   2 min 50%   4 min 40%   6 min 30%   8 min 20%   10 min 10%
 *   12 min 10%  14 min 10%  16 min 10%  18 min 10%  20 min 50%
 *
 * Every entry is a single independent roll. A hit ends the run. If all ten rolls
 * miss, this attempt is over and nothing more is sent until the user speaks
 * again - which restarts the schedule from the top.
 *
 * Two other limits still apply from the product spec: ten unprompted lines per
 * user turn, and a twenty-minute idle cutoff (the schedule reaches that anyway).
 *
 * Emotional weight raises the odds: a message that reads sad or agitated lifts
 * the next three rolls to 80%, consumed one per roll whether or not any hits.
 *
 * This module owns only the timer and the probability. Producing and persisting
 * the message is the host's job, passed in as `fire`, so this file never has to
 * know how a session is stored.
 */
/** True when the text reads as distress or agitation rather than neutral talk. */
export declare function detectEmotion(text: string): boolean;
/** True when the message reads as genuine distress rather than irritation. */
export declare function detectDeepSadness(text: string): boolean;
/**
 * The part of a pulse that survives a process restart.
 *
 * `lastUserAt` is absolute, not a countdown: the elapsed-minute arithmetic in
 * `tick()` reads the same number after a restart, so the schedule resumes at the
 * point it had reached instead of starting over.
 */
export interface PersistedPulse {
    sessionId: string;
    lastUserAt: number;
    sentSinceUser: number;
    lastSentAt: number;
    boostTicks: number;
    lastRollMark: number;
    deepSadPending: boolean;
    immediateLeft: number;
    /** 预计吐完的时刻。旧文件没有这个字段，按 0 处理。 */
    deliveringUntil?: number;
}
/** Where the pulse list is kept. Injected so this module never touches disk. */
export interface PulsePersistence {
    load: () => PersistedPulse[];
    save: (entries: PersistedPulse[]) => void;
}
export declare class NaturalChat {
    /** Produce one unprompted line. Return true when a message was delivered. */
    private readonly fire;
    /** Optional: keeps the schedule alive across a restart. */
    private readonly persistence?;
    private readonly states;
    private readonly inFlight;
    constructor(
    /** Produce one unprompted line. Return true when a message was delivered. */
    fire: (sessionId: string) => Promise<boolean>, 
    /** Optional: keeps the schedule alive across a restart. */
    persistence?: PulsePersistence | undefined);
    /**
     * Re-arm the pulses that were running when the process stopped.
     *
     * Called once at startup with the ids that still exist, so a deleted
     * conversation cannot resurrect itself. A pulse that already reached the
     * twenty-line cap is dropped rather than revived.
     */
    resume(validSessionIds: string[]): number;
    /** Write the current schedule to the injected store. Never throws. */
    private persist;
    /**
     * The user spoke: reset the counters and start (or keep) the pulse.
     * `text` is the message they just sent; it decides whether the next rolls run
     * hot. A neutral message drops any boost still pending, because the mood has
     * moved on.
     */
    noteUserTurn(sessionId: string, text?: string): void;
    /**
     * The reply to the user's message has been delivered.
     *
     * If that message read as real distress, two follow-ups go out on their own -
     * eight seconds later, then thirty - before the ordinary schedule resumes.
     * One answer is not company when someone says they are worthless.
     */
    noteReplyFinished(sessionId: string): void;
    /** One of the two distress follow-ups. Does not consume a schedule roll. */
    private tickImmediate;
    /** Explicit stop, e.g. the conversation was deleted or the mode switched off. */
    stop(sessionId: string): void;
    /**
     * 安静模式：只停掉心跳，不排期。
     *
     * 他发消息时调这个，而不是 noteUserTurn——后者会 arm 心跳，一分钟一跳，
     * 到点按概率主动开口。安静模式要的是「只回不主动」，所以这里连状态一起删：
     * 没有 state 就不会有下一次 tick，重启后也不会从 persist 里复活。
     */
    markUserTurnQuiet(sessionId: string): void;
    /** 从安静切回热情：从现在开始重新排期，不补攒下的空白。 */
    resumeSchedule(sessionId: string): void;
    stopAll(): void;
    /** Snapshot for diagnostics / the status surface. */
    describe(sessionId: string): {
        running: boolean;
        sentSinceUser: number;
        idleMs: number;
        boostTicks: number;
        lastRollMark: number;
    };
    private arm;
    private tick;
}
//# sourceMappingURL=NaturalChat.d.ts.map