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
exports.ArtifactStore = void 0;
const fs_1 = require("fs");
const path = __importStar(require("path"));
class ArtifactStore {
    root;
    constructor(root) {
        this.root = root;
    }
    async put(content, extension = '.txt') {
        await fs_1.promises.mkdir(this.root, { recursive: true });
        const id = `artifact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
        const filePath = path.join(this.root, `${id}${extension}`);
        await fs_1.promises.writeFile(filePath, content, 'utf8');
        const stat = await fs_1.promises.stat(filePath);
        return { id, path: filePath, size: stat.size, createdAt: Date.now() };
    }
}
exports.ArtifactStore = ArtifactStore;
//# sourceMappingURL=ArtifactStore.js.map