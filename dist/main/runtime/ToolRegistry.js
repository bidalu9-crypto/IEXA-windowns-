"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolRegistry = void 0;
exports.canonicalToolName = canonicalToolName;
const MAX_ARGUMENT_DEPTH = 12;
const MAX_ARGUMENT_NODES = 20_000;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
// Models frequently reach for `edit` / `edit_file` from other harnesses. The
// arguments already match file_edit, so resolve the name before validation,
// permissions, fingerprinting and execution.
const TOOL_ALIASES = {
    edit: 'file_edit',
    edit_file: 'file_edit',
    fileedit: 'file_edit',
};
function canonicalToolName(name) {
    return TOOL_ALIASES[name] || name;
}
function validateValue(value, schema, location, depth, state) {
    state.nodes++;
    if (state.nodes > MAX_ARGUMENT_NODES)
        throw new Error(`Tool arguments exceed the maximum complexity at ${location}.`);
    if (depth > MAX_ARGUMENT_DEPTH)
        throw new Error(`Tool arguments exceed the maximum nesting depth at ${location}.`);
    switch (schema.type) {
        case 'string':
            if (typeof value !== 'string')
                throw new Error(`Invalid argument ${location}: expected string.`);
            if (schema.enumValues && !schema.enumValues.includes(value))
                throw new Error(`Invalid argument ${location}: expected one of ${schema.enumValues.join(', ')}.`);
            return value;
        case 'integer': {
            if (typeof value !== 'number' || !Number.isSafeInteger(value))
                throw new Error(`Invalid argument ${location}: expected safe integer.`);
            // A number just outside a declared bound is a usable request, not a broken
            // one: the tool implementation clamps anyway, and rejecting it costs a whole
            // round trip. Clamp here and tell the caller what changed.
            if (schema.minimum !== undefined && value < schema.minimum) {
                state.repairs.push(`${location} ${value} → ${schema.minimum} (minimum is ${schema.minimum})`);
                return schema.minimum;
            }
            if (schema.maximum !== undefined && value > schema.maximum) {
                state.repairs.push(`${location} ${value} → ${schema.maximum} (maximum is ${schema.maximum})`);
                return schema.maximum;
            }
            return value;
        }
        case 'boolean':
            if (typeof value !== 'boolean')
                throw new Error(`Invalid argument ${location}: expected boolean.`);
            return value;
        case 'array':
            if (!Array.isArray(value))
                throw new Error(`Invalid argument ${location}: expected array.`);
            return schema.items
                ? value.map((item, index) => validateValue(item, schema.items, `${location}[${index}]`, depth + 1, state))
                : value;
        case 'object': {
            if (value === null || typeof value !== 'object' || Array.isArray(value))
                throw new Error(`Invalid argument ${location}: expected object.`);
            const record = value;
            for (const required of schema.required || []) {
                if (!own(record, required) || record[required] === undefined || record[required] === null)
                    throw new Error(`Missing required argument: ${location}.${required}`);
            }
            if (schema.properties) {
                for (const key of Object.keys(record))
                    if (!own(schema.properties, key))
                        throw new Error(`Unknown argument: ${location}.${key}`);
                for (const [key, childSchema] of Object.entries(schema.properties)) {
                    if (own(record, key))
                        record[key] = validateValue(record[key], childSchema, `${location}.${key}`, depth + 1, state);
                }
            }
            else {
                // Open objects are used deliberately for desktop batch steps and plugin payloads.
                for (const [key, child] of Object.entries(record))
                    validateOpenValue(child, `${location}.${key}`, depth + 1, state);
            }
            return record;
        }
    }
}
function validateOpenValue(value, location, depth, state) {
    state.nodes++;
    if (state.nodes > MAX_ARGUMENT_NODES)
        throw new Error(`Tool arguments exceed the maximum complexity at ${location}.`);
    if (depth > MAX_ARGUMENT_DEPTH)
        throw new Error(`Tool arguments exceed the maximum nesting depth at ${location}.`);
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new Error(`Invalid argument ${location}: number must be finite.`);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => validateOpenValue(item, `${location}[${index}]`, depth + 1, state));
        return;
    }
    if (typeof value === 'object') {
        for (const [key, child] of Object.entries(value))
            validateOpenValue(child, `${location}.${key}`, depth + 1, state);
        return;
    }
    throw new Error(`Invalid argument ${location}: unsupported value type.`);
}
class ToolRegistry {
    definitions = new Map();
    register(tool) { if (this.definitions.has(tool.name))
        throw new Error(`Tool already registered: ${tool.name}`); this.definitions.set(tool.name, tool); }
    get(name) { return this.definitions.get(canonicalToolName(name)); }
    has(name) { return this.definitions.has(canonicalToolName(name)); }
    list() { return [...this.definitions.values()]; }
    /**
     * A wrong tool name is usually a near miss (`edit`, `read_file`, `Write`).
     * Naming the closest real tool lets the model recover in one turn instead of
     * guessing again, which is cheaper than a full retry.
     */
    suggest(name) {
        const wanted = String(name || '').toLowerCase();
        const names = this.list().map((tool) => tool.name);
        const distance = (a, b) => {
            const rows = a.length + 1;
            const cols = b.length + 1;
            let previous = Array.from({ length: cols }, (_, i) => i);
            for (let i = 1; i < rows; i += 1) {
                const current = [i];
                for (let j = 1; j < cols; j += 1) {
                    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                    current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
                }
                previous = current;
            }
            return previous[cols - 1];
        };
        const ranked = names
            .map((candidate) => ({ candidate, score: distance(wanted, candidate.toLowerCase()) }))
            .sort((a, b) => a.score - b.score);
        const close = ranked.filter((entry) => entry.score <= Math.max(2, Math.floor(wanted.length / 3))).slice(0, 3);
        if (close.length)
            return `Did you mean: ${close.map((entry) => entry.candidate).join(', ')}?`;
        return `Valid tools: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}`;
    }
    /** Validate in place; returns the human-readable list of clamped arguments. */
    validate(name, args) {
        const tool = this.get(name);
        if (!tool)
            throw new Error(`Unknown tool: ${name}. ${this.suggest(name)}`);
        if (args === null || typeof args !== 'object' || Array.isArray(args))
            throw new Error('Tool arguments must be an object.');
        for (const required of tool.required || [])
            if (!own(args, required) || args[required] === undefined || args[required] === null)
                throw new Error(`Missing required argument: ${required}`);
        for (const key of Object.keys(args))
            if (!own(tool.parameters, key))
                throw new Error(`Unknown argument: ${key}. Valid: ${Object.keys(tool.parameters).join(', ') || '(none)'}`);
        const state = { nodes: 0, repairs: [] };
        for (const [key, schema] of Object.entries(tool.parameters)) {
            if (own(args, key))
                args[key] = validateValue(args[key], schema, key, 0, state);
        }
        return state.repairs;
    }
}
exports.ToolRegistry = ToolRegistry;
//# sourceMappingURL=ToolRegistry.js.map