"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoopDetector = void 0;
const IexaError_1 = require("../errors/IexaError");
function canonical(value) {
    if (Array.isArray(value))
        return value.map(canonical);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
    return value;
}
class LoopDetector {
    maxRepeat;
    windowSize;
    recent = [];
    constructor(maxRepeat = 3, windowSize = 12) {
        this.maxRepeat = maxRepeat;
        this.windowSize = windowSize;
        if (!Number.isSafeInteger(maxRepeat) || maxRepeat < 1 || !Number.isSafeInteger(windowSize) || windowSize < maxRepeat + 1) {
            throw new IexaError_1.IexaError('LOOP_CONFIG', 'CONFIG', 'Loop detector limits are invalid.');
        }
    }
    reset() { this.recent = []; }
    record(name, args) {
        const key = `${name}:${JSON.stringify(canonical(args))}`;
        this.recent.push(key);
        if (this.recent.length > this.windowSize)
            this.recent.shift();
        if (this.recent.filter((item) => item === key).length > this.maxRepeat) {
            throw new IexaError_1.IexaError('LOOP_DETECTED', 'RUNTIME', `检测到工具 ${name} 重复调用，任务已停止。`);
        }
    }
}
exports.LoopDetector = LoopDetector;
//# sourceMappingURL=LoopDetector.js.map