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
exports.handleSteerRoute = handleSteerRoute;
/**
 * Steer: inject a user message into the turn that is already streaming.
 *
 * This route deliberately does not touch the conversation history itself: it
 * validates attachments, then hands the message to the live AgentLoop, which
 * commits it at the next step boundary. The chat stream owns persistence and
 * emits `steer_applied` / `steer_dropped` back to the renderer.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const HttpServer_1 = require("./HttpServer");
const FileRoutes_1 = require("./FileRoutes");
const PathSandbox_1 = require("../security/PathSandbox");
const ImageMetadata_1 = require("../vision/ImageMetadata");
async function handleSteerRoute(req, res, url, ctx) {
    if (url.pathname !== '/api/steer' || req.method !== 'POST')
        return false;
    try {
        const raw = JSON.parse(await (0, HttpServer_1.readBody)(req, ctx.limits.maxBodyBytes));
        const sessionId = String(raw.sessionId || '');
        const steerId = String(raw.steerId || '');
        const message = String(raw.message || '');
        const rawAttachments = Array.isArray(raw.attachments) ? raw.attachments : [];
        if (!sessionId)
            throw new Error('sessionId required');
        if (!steerId)
            throw new Error('steerId required');
        if (!message.trim() && rawAttachments.length === 0)
            throw new Error('message required');
        if (!ctx.isAgentRunning(sessionId)) {
            (0, HttpServer_1.jsonReply)(res, 409, { error: 'turn_not_running' });
            return true;
        }
        const useVisionProxy = ctx.usesVisionProxy(sessionId);
        const attachRoot = path.join(ctx.workspaceDir, 'uploads', sessionId);
        const agentAttachments = [];
        const metaAttachments = [];
        let totalBytes = 0;
        for (const item of rawAttachments.slice(0, ctx.limits.maxAttachments)) {
            const safeName = (0, FileRoutes_1.sanitizeFileName)(item.name || 'file');
            const kind = (item.kind === 'image' || item.kind === 'text' || item.kind === 'file')
                ? item.kind
                : (item.mime || '').startsWith('image/') ? 'image'
                    : item.text != null ? 'text' : 'file';
            const mime = item.mime || (kind === 'image' ? 'image/png' : kind === 'text' ? 'text/plain' : 'application/octet-stream');
            let data;
            const text = item.text;
            let savedPath;
            let previewUrl;
            if (typeof item.savedPath === 'string' && item.savedPath) {
                const attachmentRoot = path.resolve(attachRoot);
                if (!fs.existsSync(attachmentRoot))
                    throw new Error(`附件目录不存在：${safeName}`);
                const candidate = (0, PathSandbox_1.resolveScopedPath)(path.resolve(ctx.workspaceDir, item.savedPath), [attachmentRoot]);
                const uploadRoot = fs.realpathSync.native(attachmentRoot);
                const relative = path.relative(uploadRoot, candidate);
                if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(candidate))
                    throw new Error(`上传文件不存在：${safeName}`);
                const stat = fs.statSync(candidate);
                if (!stat.isFile() || stat.size > ctx.limits.maxUploadBytes)
                    throw new Error(`上传文件大小或类型无效：${safeName}`);
                totalBytes += stat.size;
                savedPath = candidate;
                if (kind === 'image') {
                    if (stat.size > ctx.limits.maxVisionImageBytes)
                        throw new Error(`图片超过 ${ctx.limits.maxVisionImageBytes / (1024 * 1024)} MB：${safeName}`);
                    data = fs.readFileSync(candidate);
                    previewUrl = `/api/attachments/${encodeURIComponent(sessionId)}/${encodeURIComponent(path.basename(candidate))}`;
                }
            }
            else if (kind === 'image' && typeof item.dataUrl === 'string') {
                const match = item.dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
                if (!match)
                    throw new Error(`图片数据无效：${safeName}`);
                const bytes = Buffer.from(match[2], 'base64');
                if (bytes.length > ctx.limits.maxVisionImageBytes)
                    throw new Error(`图片超过 ${ctx.limits.maxVisionImageBytes / (1024 * 1024)} MB：${safeName}`);
                fs.mkdirSync(attachRoot, { recursive: true });
                const destName = `${Date.now().toString(36)}_${safeName}`;
                const dest = path.join(attachRoot, destName);
                fs.writeFileSync(dest, bytes);
                totalBytes += bytes.length;
                savedPath = dest;
                data = bytes;
                previewUrl = `/api/attachments/${encodeURIComponent(sessionId)}/${encodeURIComponent(destName)}`;
            }
            else if (kind === 'text' && typeof text === 'string') {
                totalBytes += Buffer.byteLength(text, 'utf8');
            }
            else {
                throw new Error(`插入消息的附件必须先保存到会话目录：${safeName}`);
            }
            if (totalBytes > ctx.limits.maxAttachmentTotalBytes)
                throw new Error(`附件总大小超过 ${ctx.limits.maxAttachmentTotalBytes / (1024 * 1024)} MB`);
            const dimensions = kind === 'image' && data ? (0, ImageMetadata_1.imageDimensions)(data, mime) : undefined;
            agentAttachments.push({
                name: safeName,
                mime,
                kind,
                data: kind === 'image' && useVisionProxy ? undefined : data,
                text: kind === 'text' ? text : undefined,
                savedPath,
                width: dimensions?.width,
                height: dimensions?.height,
            });
            metaAttachments.push({
                name: safeName,
                mime,
                kind,
                savedPath: savedPath ? path.relative(ctx.workspaceDir, savedPath).replace(/\\/g, '/') : undefined,
                previewUrl,
            });
        }
        if (!ctx.steer(sessionId, { id: steerId, text: message, attachments: agentAttachments })) {
            (0, HttpServer_1.jsonReply)(res, 409, { error: 'turn_not_running' });
            return true;
        }
        ctx.rememberMeta(sessionId, steerId, {
            content: message,
            attachments: metaAttachments.length ? metaAttachments : undefined,
        });
        (0, HttpServer_1.jsonReply)(res, 202, { ok: true, steerId });
    }
    catch (error) {
        (0, HttpServer_1.jsonReply)(res, 400, { error: error.message || '插入消息失败。' });
    }
    return true;
}
//# sourceMappingURL=SteerRoutes.js.map