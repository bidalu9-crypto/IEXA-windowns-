"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.desktopAdapterRegistry = exports.DesktopAdapterRegistry = void 0;
class GenericDesktopAdapter {
    id = 'generic-uia';
    priority = 0;
    capabilities = ['background_capture', 'semantic_controls', 'invoke', 'value', 'verification'];
    matches() { return true; }
    preflight(_context, action) {
        const allowed = new Set(['list_windows', 'observe', 'bind_window', 'session_state', 'find_element', 'click_element', 'type_element', 'frame']);
        return !allowed.has(action)
            ? { allowed: false, reason: 'Generic background adapter only permits UIA Invoke/Value; physical input requires foreground ownership.' }
            : { allowed: true };
    }
}
/**
 * Application adapters are deliberately opt-in. A missing adapter is not a
 * reason to guess with OCR/coordinates: the generic adapter fails closed for
 * background input and preserves the user's foreground window.
 */
class DesktopAdapterRegistry {
    adapters = [new GenericDesktopAdapter()];
    register(adapter) {
        if (this.adapters.some(existing => existing.id === adapter.id))
            throw new Error(`Desktop adapter already registered: ${adapter.id}`);
        this.adapters.push(adapter);
        this.adapters.sort((a, b) => b.priority - a.priority);
    }
    resolve(context) {
        return this.adapters.find(adapter => adapter.matches(context)) || this.adapters[this.adapters.length - 1];
    }
    describe(context) {
        const adapter = this.resolve(context);
        return { id: adapter.id, capabilities: [...adapter.capabilities] };
    }
}
exports.DesktopAdapterRegistry = DesktopAdapterRegistry;
exports.desktopAdapterRegistry = new DesktopAdapterRegistry();
//# sourceMappingURL=DesktopBackgroundAdapter.js.map