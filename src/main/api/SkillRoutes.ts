/**
 * Skills: list, import, edit and toggle.
 *
 * Every mutation invalidates cached agents. A skill's body is compiled into the
 * system prompt, so an agent built before the edit would keep serving the old
 * text for the rest of its life.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { URL } from 'url';
import { jsonReply, readBody, HttpError } from './HttpServer';
import { SkillStore } from '../skills/SkillStore';

export interface SkillRouteContext {
  skills: SkillStore;
  skillsChanged: () => void;
}

export async function handleSkillRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: SkillRouteContext,
): Promise<boolean> {
if (url.pathname === '/api/skills' && req.method === 'GET') {
      ctx.skills.reload(); // always rescan disk so Explorer edits show up
      jsonReply(res, 200, {
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
      } catch { /* */ }
      jsonReply(res, 200, { path: dir });
      return true;
    }

if (url.pathname === '/api/skills' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { content, source } = JSON.parse(body || '{}');
        if (!content || typeof content !== 'string') {
          jsonReply(res, 400, { error: '需要 content（SKILL.md 文本）' });
          return true;
        }
        const skill = ctx.skills.importFromContent(
          content,
          source === 'file' || source === 'url' || source === 'session' ? source : 'paste',
        );
        ctx.skillsChanged();
        jsonReply(res, 200, { skill });
      } catch (err) {
        jsonReply(res, 400, { error: (err as Error).message || '导入失败' });
      }
      return true;
    }

if (url.pathname.startsWith('/api/skills/')) {
      const id = decodeURIComponent(url.pathname.replace('/api/skills/', '').split('/')[0] || '');
      if (!id) {
        jsonReply(res, 400, { error: '缺少 skill id' });
        return true;
      }

      if (req.method === 'GET') {
        const skill = ctx.skills.get(id);
        if (!skill) { jsonReply(res, 404, { error: '未找到' }); return true; }
        let raw = '';
        try { raw = fs.readFileSync(skill.skillPath, 'utf-8'); } catch { /* */ }
        jsonReply(res, 200, { skill, content: raw });
        return true;
      }

      if (req.method === 'PUT') {
        const body = await readBody(req);
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
          jsonReply(res, 200, { skill: updated });
        } catch (err) {
          jsonReply(res, 400, { error: (err as Error).message });
        }
        return true;
      }

      if (req.method === 'DELETE') {
        const ok = ctx.skills.delete(id);
        if (ok) {
          ctx.skillsChanged();
        }
        jsonReply(res, ok ? 200 : 404, ok ? { ok: true } : { error: '未找到' });
        return true;
      }
    }
  return false;
}
