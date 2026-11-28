"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CancellationManager = void 0;
class CancellationManager {
    controllers = new Map();
    begin(sessionId) {
        this.cancel(sessionId);
        const controller = new AbortController();
        this.controllers.set(sessionId, controller);
        return controller.signal;
    }
    signal(sessionId) { return this.controllers.get(sessionId)?.signal; }
    cancel(sessionId) { this.controllers.get(sessionId)?.abort(); this.controllers.delete(sessionId); }
    finish(sessionId) { this.controllers.delete(sessionId); }
}
exports.CancellationManager = CancellationManager;
//# sourceMappingURL=CancellationManager.js.map