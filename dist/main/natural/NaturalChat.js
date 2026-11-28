"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NaturalChat = void 0;
exports.detectEmotion = detectEmotion;
exports.detectDeepSadness = detectDeepSadness;
/** One heartbeat per minute. Only the marks below actually roll. */
const TICK_MS = 60_000;
/**
 * When a roll happens, and how likely it is.
 *
 * 第 1 分钟不再掷骰：他刚说完话，一分钟就插一句太急了，那更像客服回访，
 * 不像一个人在陪他。现在最早的一次机会落在第 2 分钟。心跳仍是一分钟一次，
 * 这样判断依据始终是「经过了几分钟」，不会被 tick 计数带偏。
 *
 * 2–30 分钟每 2 分钟一次，50%；30–60 分钟每 2 分钟一次，30%；60 分钟以后
 * 每 30 分钟一次，50%。标记之间不掷骰，所以定时器可以保持朴素的一分钟心跳。
 */
function isRollMark(minutes) {
    if (minutes > 1 && minutes <= 60)
        return minutes % 2 === 0;
    if (minutes > 60)
        return (minutes - 60) % 30 === 0;
    return false;
}
function chanceAt(minutes) {
    if (minutes <= 30)
        return 0.5;
    if (minutes <= 60)
        return 0.3;
    return 0.5;
}
const BOOST_CHANCE = 0.8;
const BOOST_TICKS = 3;
const MAX_UNPROMPTED = 20;
/**
 * 一轮气泡从投递到吐完的大致时长。
 *
 * 六到二十个气泡、每个间隔 3–7 秒，实际是三十到一百秒。取 45 秒是个折中：
 * 短回复能留出余量，长回复最多让下一条多等半分钟——比两条交错好。
 */
const DELIVERY_WINDOW_MS = 45_000;
/**
 * Distress words. Kept as whole-token matches where Chinese allows it so
 * "不累" and "没问题" do not read as complaints.
 */
const SAD_WORDS = [
    '难过', '难受', '伤心', '想哭', '哭了', '崩溃', '绝望', '心痛', '心碎',
    '孤独', '寂寞', '委屈', '痛苦', '压抑', '郁闷', '失落', '沮丧', '消沉',
    '焦虑', '害怕', '恐惧', '麻木', '空虚', '糟糕', '完了', '失败', '废物',
    '没用', '自责', '对不起', '抱歉', '撑不住', '熬不住', '受不了了', '没意思',
    '不想活', '抑郁', '好累', '太累', '心累', '疲惫', '喘不过气', '想哭',
    'sad', 'lonely', 'depressed', 'hopeless', 'exhausted', 'crying',
];
const ANGRY_WORDS = [
    '生气', '愤怒', '气死', '好烦', '太烦', '讨厌', '可恶', '过分', '凭什么',
    '受不了', '气炸', '火大', '抓狂', '妈的', '卧槽', '滚蛋', '闭嘴', '别烦',
    '急死', '烦死', '恶心', '无语', '离谱', '气人', '恼火', '暴躁', '激动',
    'angry', 'furious', 'annoyed', 'pissed', 'wtf',
];
/** True when the text reads as distress or agitation rather than neutral talk. */
function detectEmotion(text) {
    const value = String(text || '').trim();
    if (!value)
        return false;
    const lower = value.toLowerCase();
    for (const word of SAD_WORDS)
        if (lower.includes(word))
            return true;
    for (const word of ANGRY_WORDS)
        if (lower.includes(word))
            return true;
    // Repeated punctuation is the other reliable tell: "！！！" or "？？？" is not
    // neutral typing, and a run of exclamation marks after a short line usually
    // means the message is being shouted rather than written.
    if (/[!！]{2,}/.test(value) || /[?？]{3,}/.test(value))
        return true;
    return false;
}
/**
 * Distress that is about himself, not about the world.
 *
 * `detectEmotion` answers "is he upset". This answers "is he hurting enough that
 * a reply is not the end of it" - self-blame, hopelessness, collapse. Those
 * messages are the ones a person does not walk away from after one answer.
 */
const DEEP_SAD_WORDS = [
    '难过', '难受', '伤心', '想哭', '哭了', '崩溃', '绝望', '心痛', '心碎',
    '孤独', '寂寞', '委屈', '痛苦', '压抑', '郁闷', '失落', '沮丧', '消沉',
    '焦虑', '害怕', '恐惧', '麻木', '空虚', '糟糕', '失败', '废物',
    '没用', '自责', '撑不住', '熬不住', '受不了了', '没意思',
    '不想活', '抑郁', '好累', '太累', '心累', '疲惫', '喘不过气',
    '败类', '不如死', '想消失', '活着没意思', '一无是处', '我这种人',
    'sad', 'lonely', 'depressed', 'hopeless', 'exhausted', 'worthless', 'useless',
];
/** True when the message reads as genuine distress rather than irritation. */
function detectDeepSadness(text) {
    const value = String(text || '').trim();
    if (!value)
        return false;
    const lower = value.toLowerCase();
    for (const word of DEEP_SAD_WORDS)
        if (lower.includes(word))
            return true;
    return false;
}
class NaturalChat {
    fire;
    persistence;
    states = new Map();
    inFlight = new Set();
    constructor(
    /** Produce one unprompted line. Return true when a message was delivered. */
    fire, 
    /** Optional: keeps the schedule alive across a restart. */
    persistence) {
        this.fire = fire;
        this.persistence = persistence;
    }
    /**
     * Re-arm the pulses that were running when the process stopped.
     *
     * Called once at startup with the ids that still exist, so a deleted
     * conversation cannot resurrect itself. A pulse that already reached the
     * twenty-line cap is dropped rather than revived.
     */
    resume(validSessionIds) {
        if (!this.persistence)
            return 0;
        const alive = new Set(validSessionIds);
        let restored = 0;
        for (const entry of this.persistence.load()) {
            if (!entry || typeof entry.sessionId !== 'string' || !entry.sessionId)
                continue;
            if (!alive.has(entry.sessionId))
                continue;
            if (this.states.has(entry.sessionId))
                continue;
            if (Number(entry.sentSinceUser) >= MAX_UNPROMPTED)
                continue;
            if (!Number.isFinite(entry.lastUserAt) || entry.lastUserAt <= 0)
                continue;
            const state = {
                timer: null,
                lastUserAt: entry.lastUserAt,
                sentSinceUser: Math.max(0, Number(entry.sentSinceUser) || 0),
                lastSentAt: Number(entry.lastSentAt) || 0,
                boostTicks: Math.max(0, Number(entry.boostTicks) || 0),
                lastRollMark: Math.max(0, Number(entry.lastRollMark) || 0),
                deepSadPending: entry.deepSadPending === true,
                immediateLeft: Math.max(0, Number(entry.immediateLeft) || 0),
                deliveringUntil: Math.max(0, Number(entry.deliveringUntil) || 0),
            };
            this.states.set(entry.sessionId, state);
            this.arm(entry.sessionId, state);
            restored += 1;
        }
        this.persist();
        return restored;
    }
    /** Write the current schedule to the injected store. Never throws. */
    persist() {
        if (!this.persistence)
            return;
        const entries = [];
        for (const [sessionId, state] of this.states) {
            entries.push({
                sessionId,
                lastUserAt: state.lastUserAt,
                sentSinceUser: state.sentSinceUser,
                lastSentAt: state.lastSentAt,
                boostTicks: state.boostTicks,
                lastRollMark: state.lastRollMark,
                deepSadPending: state.deepSadPending,
                immediateLeft: state.immediateLeft,
                deliveringUntil: state.deliveringUntil,
            });
        }
        try {
            this.persistence.save(entries);
        }
        catch {
            /* A failed write must not stop the pulse that is already running. */
        }
    }
    /**
     * The user spoke: reset the counters and start (or keep) the pulse.
     * `text` is the message they just sent; it decides whether the next rolls run
     * hot. A neutral message drops any boost still pending, because the mood has
     * moved on.
     */
    noteUserTurn(sessionId, text = '') {
        if (!sessionId)
            return;
        const state = this.states.get(sessionId) || {
            timer: null, lastUserAt: 0, sentSinceUser: 0, lastSentAt: 0, boostTicks: 0, lastRollMark: 0,
            deepSadPending: false, immediateLeft: 0, deliveringUntil: 0,
        };
        state.lastUserAt = Date.now();
        state.sentSinceUser = 0;
        state.lastRollMark = 0;
        state.boostTicks = detectEmotion(text) ? BOOST_TICKS : 0;
        // Recorded now, acted on after the reply finishes: firing while the normal
        // answer is still streaming would collide with it.
        state.deepSadPending = detectDeepSadness(text);
        state.immediateLeft = 0;
        this.states.set(sessionId, state);
        this.arm(sessionId, state);
        this.persist();
    }
    /**
     * The reply to the user's message has been delivered.
     *
     * If that message read as real distress, two follow-ups go out on their own -
     * eight seconds later, then thirty - before the ordinary schedule resumes.
     * One answer is not company when someone says they are worthless.
     */
    noteReplyFinished(sessionId) {
        const state = this.states.get(sessionId);
        if (!state || !state.deepSadPending)
            return;
        state.deepSadPending = false;
        state.immediateLeft = 2;
        for (const delay of [8_000, 30_000]) {
            setTimeout(() => { void this.tickImmediate(sessionId); }, delay).unref?.();
        }
        this.persist();
    }
    /** One of the two distress follow-ups. Does not consume a schedule roll. */
    async tickImmediate(sessionId) {
        const state = this.states.get(sessionId);
        if (!state || state.immediateLeft <= 0)
            return;
        if (this.inFlight.has(sessionId))
            return;
        if (state.sentSinceUser >= MAX_UNPROMPTED)
            return;
        // 上一条还在吐气泡：等它吐完再来。
        //
        // 这里排队而不是跳过——难过时的两条跟进是她该说的话，不能因为撞上节奏
        // 就少说一句。原来 8 秒和 30 秒两条是同时排期的，第一条生成完开始吐气泡
        // 时第二条就插进去了，屏幕上两条交错着冒。
        const waitMs = state.deliveringUntil - Date.now();
        if (waitMs > 0) {
            setTimeout(() => { void this.tickImmediate(sessionId); }, waitMs + 500).unref?.();
            return;
        }
        state.immediateLeft -= 1;
        this.inFlight.add(sessionId);
        try {
            const delivered = await this.fire(sessionId);
            if (delivered) {
                state.sentSinceUser += 1;
                state.lastSentAt = Date.now();
                state.deliveringUntil = Date.now() + DELIVERY_WINDOW_MS;
            }
            this.persist();
        }
        catch (error) {
            console.error('[NaturalChat] immediate follow-up failed:', error?.message || error);
        }
        finally {
            this.inFlight.delete(sessionId);
        }
    }
    /** Explicit stop, e.g. the conversation was deleted or the mode switched off. */
    stop(sessionId) {
        const state = this.states.get(sessionId);
        if (state?.timer)
            clearInterval(state.timer);
        this.states.delete(sessionId);
        this.persist();
    }
    /**
     * 安静模式：只停掉心跳，不排期。
     *
     * 他发消息时调这个，而不是 noteUserTurn——后者会 arm 心跳，一分钟一跳，
     * 到点按概率主动开口。安静模式要的是「只回不主动」，所以这里连状态一起删：
     * 没有 state 就不会有下一次 tick，重启后也不会从 persist 里复活。
     */
    markUserTurnQuiet(sessionId) {
        if (!sessionId)
            return;
        const state = this.states.get(sessionId);
        if (state?.timer)
            clearInterval(state.timer);
        this.states.delete(sessionId);
        this.persist();
    }
    /** 从安静切回热情：从现在开始重新排期，不补攒下的空白。 */
    resumeSchedule(sessionId) {
        if (!sessionId)
            return;
        const state = this.states.get(sessionId);
        if (!state) {
            this.noteUserTurn(sessionId, '');
            return;
        }
        state.lastUserAt = Date.now();
        state.sentSinceUser = 0;
        state.lastRollMark = 0;
        state.immediateLeft = 0;
        state.deepSadPending = false;
        this.arm(sessionId, state);
        this.persist();
    }
    stopAll() {
        for (const id of [...this.states.keys()])
            this.stop(id);
    }
    /** Snapshot for diagnostics / the status surface. */
    describe(sessionId) {
        const state = this.states.get(sessionId);
        if (!state)
            return { running: false, sentSinceUser: 0, idleMs: 0, boostTicks: 0, lastRollMark: 0 };
        return {
            running: Boolean(state.timer),
            sentSinceUser: state.sentSinceUser,
            idleMs: Date.now() - state.lastUserAt,
            boostTicks: state.boostTicks,
            lastRollMark: state.lastRollMark,
        };
    }
    arm(sessionId, state) {
        if (state.timer)
            return;
        state.timer = setInterval(() => { void this.tick(sessionId); }, TICK_MS);
        state.timer.unref?.();
    }
    async tick(sessionId) {
        const state = this.states.get(sessionId);
        if (!state)
            return;
        // Twenty lines is the cap for one stretch of silence. Reaching it ends the
        // pulse until the user speaks again, which restarts the schedule.
        if (state.sentSinceUser >= MAX_UNPROMPTED) {
            this.stop(sessionId);
            return;
        }
        const minutes = Math.floor((Date.now() - state.lastUserAt) / 60_000);
        // Each mark is judged once. The heartbeat can fire a few milliseconds early
        // or late, and without this guard a single minute could roll twice.
        if (minutes === state.lastRollMark)
            return;
        if (!isRollMark(minutes))
            return;
        state.lastRollMark = minutes;
        // 有激进消息还在排队：这一分钟的机会让给它。
        //
        // 用户说了难过的话，先把她该说的两条说完，而不是按概率再叠一条进来。
        // lastRollMark 已经推进，所以这一分钟的机会确实丢掉了——不是推迟。
        // boostTicks 不消耗：那是同一份情绪攒下的，留给下一次真正的掷骰。
        if (state.immediateLeft > 0)
            return;
        // A boosted roll overrides the schedule but is still spent on a miss: three
        // chances at 80%, then back to the mark's own rate.
        let chance = chanceAt(minutes);
        if (state.boostTicks > 0) {
            chance = BOOST_CHANCE;
            state.boostTicks -= 1;
        }
        // The roll itself is a state change worth keeping: a restart after this
        // point must not re-judge the same minute.
        this.persist();
        if (Math.random() >= chance)
            return;
        // The roll hit, but she is still delivering the previous line. That answer
        // is not worth interrupting, so this chance is dropped - the next mark rolls
        // on its own terms.
        if (this.inFlight.has(sessionId))
            return;
        // 上一轮气泡还没吐完，同样不再起一条：两条交错比少说一句更糟。
        if (Date.now() < state.deliveringUntil)
            return;
        this.inFlight.add(sessionId);
        try {
            const delivered = await this.fire(sessionId);
            if (delivered) {
                state.sentSinceUser += 1;
                state.lastSentAt = Date.now();
                state.deliveringUntil = Date.now() + DELIVERY_WINDOW_MS;
                this.persist();
                // A hit does not reset the schedule. The marks keep coming while the
                // user stays quiet; only the twenty-line cap or a new message from them
                // ends the run.
            }
            else {
                // `false` is a silent no-op inside the host, so log it here: without a
                // line per roll there is no way to tell "she chose not to speak" from
                // "every attempt failed".
                console.log(`[NaturalChat] roll hit but nothing delivered (session ${sessionId})`);
            }
        }
        catch (error) {
            // A failed generation is simply a missed roll, but staying silent made a
            // systematically broken generator look like "she stopped talking".
            console.error('[NaturalChat] unprompted generation failed:', error?.message || error);
        }
        finally {
            this.inFlight.delete(sessionId);
        }
    }
}
exports.NaturalChat = NaturalChat;
//# sourceMappingURL=NaturalChat.js.map