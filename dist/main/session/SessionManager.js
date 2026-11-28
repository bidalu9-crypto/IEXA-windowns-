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
exports.SessionManager = void 0;
const syncFs = __importStar(require("fs"));
const path = __importStar(require("path"));
const JsonStore_1 = require("../persistence/JsonStore");
class SessionManager {
    root;
    constructor(root) {
        this.root = root;
    }
    file(id) { if (!/^[A-Za-z0-9_-]+$/.test(id))
        throw new Error('Invalid session id'); return path.join(this.root, `${id}.json`); }
    async load(id) { return this.loadSync(id); }
    async save(id, value) { await new JsonStore_1.JsonStore(this.file(id), () => value).save(value); }
    loadSync(id) { const file = this.file(id); if (!syncFs.existsSync(file) && !syncFs.existsSync(`${file}.bak`))
        return null; return new JsonStore_1.JsonStore(file, () => { throw new Error(`Session ${id} is unavailable`); }).loadSync(); }
    saveSync(id, value) { new JsonStore_1.JsonStore(this.file(id), () => value).saveSync(value); }
    deleteSync(id) { try {
        syncFs.unlinkSync(this.file(id));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    } }
}
exports.SessionManager = SessionManager;
//# sourceMappingURL=SessionManager.js.map