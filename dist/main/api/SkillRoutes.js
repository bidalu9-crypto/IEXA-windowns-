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
exports.handleSkillRoute = handleSkillRoute;
/**
 * Skills: list, import, edit and toggle.
 *
 * Every mutation invalidates cached agents. A skill's body is compiled into the
 * system prompt, so an agent built before the edit would keep serving the old
 * text for the rest of its life.
 */
const fs = __importStar(require("fs"));
const HttpServer_1 = require("./HttpServer");
async function handleSkillRoute(req, res, url, ctx) {
    if (url.pathname === '/api/skills' && req.method === 'GET') {
        ctx.skills.reload(); // always rescan disk so Explorer edits show up
        (0, HttpServer_1.jsonReply)(res, 200, {
            skillsDir: ctx.skills.getSkillsDir(),
            skills: ctx.skills.list().map((s) => ({
                id: s.id,
                name: s.name,
                description: s.description,
                version: s.version,
                source: s.source,
                enabled: s.enabled,
                useCount: s.useCount,
                systemPrompt: s.systemPrompt,
                skillPath: s.skillPath,
                updatedAt: s.updatedAt,
            })),
        });
        return true;
    }
    if (url.pathname === '/api/skills/open-dir' && req.method === 'POST') {
        const dir = ctx.skills.getSkillsDir();
        try {
            fs.mkdirSync(dir, { recursive: true });
        }
        catch { /* */ }
        (0, HttpServer_1.jsonReply)(res, 200, { path: dir });
        return true;
    }
    if (url.pathname === '/api/skills' && req.method === 'POST') {
        const body = await (0, HttpServer_1.readBody)(req);
        try {
            const { content, source } = JSON.parse(body || '{}');
            if (!content || typeof content !== 'string') {
                (0, HttpServer_1.jsonReply)(res, 400, { error: '需要 content（SKILL.md 文本）' });
                return true;
            }
            const skill = ctx.skills.importFromContent(content, source === 'file' || source === 'url' || source === 'session' ? source : 'paste');
            ctx.skillsChanged();
            (0, HttpServer_1.jsonReply)(res, 200, { skill });
        }
        catch (err) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: err.message || '导入失败' });
        }
        return true;
    }
    if (url.pathname.startsWith('/api/skills/')) {
        const id = decodeURIComponent(url.pathname.replace('/api/skills/', '').split('/')[0] || '');
        if (!id) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: '缺少 skill id' });
            return true;
        }
        if (req.method === 'GET') {
            const skill = ctx.skills.get(id);
            if (!skill) {
                (0, HttpServer_1.jsonReply)(res, 404, { error: '未找到' });
                return true;
            }
            let raw = '';
            try {
                raw = fs.readFileSync(skill.skillPath, 'utf-8');
            }
            catch { /* */ }
            (0, HttpServer_1.jsonReply)(res, 200, { skill, content: raw });
            return true;
        }
        if (req.method === 'PUT') {
            const body = await (0, HttpServer_1.readBody)(req);
            try {
                const data = JSON.parse(body || '{}');
                if (typeof data.enabled === 'boolean') {
                    ctx.skills.setEnabled(id, data.enabled);
                }
                if (typeof data.systemPrompt === 'boolean') {
                    ctx.skills.setSystemPrompt(id, data.systemPrompt);
                }
                if (typeof data.content === 'string' && data.content.trim()) {
                    // Rewrite SKILL.md
                    const skill = ctx.skills.get(id);
                    if (skill) {
                        fs.writeFileSync(skill.skillPath, data.content, 'utf-8');
                        ctx.skills.reload();
                    }
                }
                // Rebuild agents so updated system-level skill content is used on the
                // next request instead of remaining captured in an old prompt.
                ctx.skillsChanged();
                const updated = ctx.skills.get(id);
                (0, HttpServer_1.jsonReply)(res, 200, { skill: updated });
            }
            catch (err) {
                (0, HttpServer_1.jsonReply)(res, 400, { error: err.message });
            }
            return true;
        }
        if (req.method === 'DELETE') {
            const ok = ctx.skills.delete(id);
            if (ok) {
                ctx.skillsChanged();
            }
            (0, HttpServer_1.jsonReply)(res, ok ? 200 : 404, ok ? { ok: true } : { error: '未找到' });
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=SkillRoutes.js.map