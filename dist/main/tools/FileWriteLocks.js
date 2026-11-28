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
exports.withFileLocks = withFileLocks;
const path = __importStar(require("path"));
/** Shared across FileTools instances and undo requests. Lock ordering prevents deadlock. */
const locks = new Map();
async function withFileLocks(paths, work) {
    const keys = [...new Set(paths.map(p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)))].sort();
    const releases = [];
    try {
        for (const key of keys) {
            const previous = locks.get(key) || Promise.resolve();
            let release;
            const current = new Promise(resolve => { release = resolve; });
            locks.set(key, current);
            await previous;
            releases.push(() => { release(); if (locks.get(key) === current)
                locks.delete(key); });
        }
        return await work();
    }
    finally {
        for (const release of releases.reverse())
            release();
    }
}
//# sourceMappingURL=FileWriteLocks.js.map