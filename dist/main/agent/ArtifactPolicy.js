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
exports.resolveArtifactPath = resolveArtifactPath;
exports.isTransientArtifact = isTransientArtifact;
exports.isServableArtifact = isServableArtifact;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Artifacts shown in chat are persisted by path, but their bytes may live in a
 * scratch directory that is cleaned up later. These helpers keep the two
 * concerns apart: transient files can be displayed live, yet they must not
 * become permanent cards, and a restored card must never outlive its file.
 */
/** Resolve the way the tool layer records paths (absolute, or workspace-relative). */
function resolveArtifactPath(workspaceDir, artifactPath) {
    return path.isAbsolute(artifactPath) ? path.resolve(artifactPath) : path.resolve(workspaceDir, artifactPath);
}
/** `.tmp/` is scratch space: show it now, never keep it in the transcript. */
function isTransientArtifact(workspaceDir, artifactPath) {
    const relative = path.relative(path.resolve(workspaceDir), resolveArtifactPath(workspaceDir, artifactPath));
    return relative === '.tmp' || relative.startsWith('.tmp' + path.sep);
}
/** A restored card is only valid while the file is still on disk. */
function isServableArtifact(workspaceDir, artifactPath) {
    try {
        return fs.statSync(resolveArtifactPath(workspaceDir, artifactPath)).isFile();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=ArtifactPolicy.js.map