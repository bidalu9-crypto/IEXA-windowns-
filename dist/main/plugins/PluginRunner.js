"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
async function readInput() {
    let body = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
        body += chunk;
        if (body.length > 2 * 1024 * 1024)
            throw new Error('插件输入超过 2 MB 限制。');
    }
    return JSON.parse(body || '{}');
}
async function main() {
    const entry = process.argv[2];
    if (!entry || !fs.existsSync(entry))
        throw new Error('插件入口不存在。');
    const payload = await readInput();
    const plugin = require(entry);
    const target = plugin.default || plugin;
    const handler = target.tools?.[payload.tool] || (target.execute ? (args, context) => target.execute(payload.tool, args, context) : undefined);
    if (typeof handler !== 'function')
        throw new Error(`插件未导出工具处理器：${payload.tool}`);
    const originalLog = console.log;
    console.log = (...args) => console.error(...args);
    try {
        const value = await handler(payload.args || {}, payload.context || {});
        const result = value && typeof value === 'object' && !Array.isArray(value) && ('output' in value || 'success' in value)
            ? value
            : { output: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2), success: true };
        process.stdout.write(JSON.stringify(result));
    }
    finally {
        console.log = originalLog;
    }
}
main().catch((error) => {
    process.stdout.write(JSON.stringify({ output: `插件执行失败：${error instanceof Error ? error.message : String(error)}`, success: false }));
    process.exitCode = 1;
});
//# sourceMappingURL=PluginRunner.js.map