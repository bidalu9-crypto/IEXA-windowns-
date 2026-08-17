import * as http from 'http';
import { URL } from 'url';
import { jsonReply, readBody } from './HttpServer';
import { WebDAVConfig } from '../webdav-sync';

export interface WebDAVRoutesContext {
  workspaceDir: string;
  sessionsDir: string;
  settingsFile: string;
  sessionsStoreFile: string;
  maskPassword(value: string): string;
  loadConfig(): WebDAVConfig;
  saveConfig(config: WebDAVConfig): void;
  testConnection(config: WebDAVConfig): Promise<{ ok: boolean; error?: string }>;
  syncAll(config: WebDAVConfig, workspaceDir: string, sessionsDir: string, settingsFile: string, sessionsStoreFile: string): Promise<{ ok: boolean; uploaded: number; downloaded: number; conflicts: unknown[]; error?: string }>;
  listConflicts(workspaceDir: string): unknown[];
  previewConflict(workspaceDir: string, id: string): unknown | null;
  resolveConflict(config: WebDAVConfig, workspaceDir: string, id: string, resolution: 'local' | 'remote' | 'merge', content?: string): Promise<unknown | null>;
}

export async function handleWebDAVRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, context: WebDAVRoutesContext): Promise<boolean> {
  if (url.pathname === '/api/webdav/config') {
    if (req.method === 'GET') {
      const config = context.loadConfig();
      jsonReply(res, 200, { ...config, password: context.maskPassword(config.password) });
      return true;
    }
    if (req.method === 'POST') {
      try {
        const input = JSON.parse(await readBody(req)) as WebDAVConfig;
        const existing = context.loadConfig();
        if (input.password && input.password !== context.maskPassword(existing.password)) existing.password = input.password;
        existing.url = input.url || existing.url;
        existing.username = input.username || existing.username;
        existing.enabled = input.enabled !== undefined ? input.enabled : existing.enabled;
        existing.autoSync = input.autoSync !== undefined ? input.autoSync : existing.autoSync;
        context.saveConfig(existing);
        jsonReply(res, 200, { ok: true });
      } catch { jsonReply(res, 400, { error: '无效的 JSON' }); }
      return true;
    }
  }
  if (url.pathname === '/api/webdav/test' && req.method === 'POST') {
    try {
      const { url: endpoint, username, password } = JSON.parse(await readBody(req));
      const result = await context.testConnection({ url: endpoint, username, password, enabled: true, autoSync: false, lastSync: 0 });
      jsonReply(res, result.ok ? 200 : 400, result);
    } catch { jsonReply(res, 400, { error: '无效的 JSON' }); }
    return true;
  }
  if (url.pathname === '/api/webdav/sync' && req.method === 'POST') {
    const config = context.loadConfig();
    if (!config.url) { jsonReply(res, 400, { error: 'WebDAV 未配置' }); return true; }
    const result = await context.syncAll(config, context.workspaceDir, context.sessionsDir, context.settingsFile, context.sessionsStoreFile);
    jsonReply(res, result.ok ? 200 : 500, result);
    return true;
  }
  if (url.pathname === '/api/webdav/status' && req.method === 'GET') {
    const config = context.loadConfig();
    jsonReply(res, 200, { configured: !!config.url, enabled: config.enabled, autoSync: config.autoSync, lastSync: config.lastSync });
    return true;
  }
  if (url.pathname === '/api/webdav/conflicts' && req.method === 'GET') {
    jsonReply(res, 200, { conflicts: context.listConflicts(context.workspaceDir) });
    return true;
  }
  if (!url.pathname.startsWith('/api/webdav/conflicts/')) return false;
  const [encodedId, action] = url.pathname.slice('/api/webdav/conflicts/'.length).split('/');
  const id = decodeURIComponent(encodedId || '');
  if (!id || !/^conflict_[A-Za-z0-9_-]+$/.test(id)) { jsonReply(res, 400, { error: '无效的冲突标识。' }); return true; }
  if (!action && req.method === 'GET') {
    const preview = context.previewConflict(context.workspaceDir, id);
    if (!preview) jsonReply(res, 404, { error: '冲突不存在或已处理。' });
    else jsonReply(res, 200, preview);
    return true;
  }
  if (action === 'resolve' && req.method === 'POST') {
    try {
      const parsed = JSON.parse(await readBody(req));
      const resolution = String(parsed.resolution || '');
      if (resolution !== 'local' && resolution !== 'remote' && resolution !== 'merge') { jsonReply(res, 400, { error: '无效的处理方式。' }); return true; }
      const config = context.loadConfig();
      if (!config.url) { jsonReply(res, 400, { error: 'WebDAV 未配置。' }); return true; }
      const resolved = await context.resolveConflict(config, context.workspaceDir, id, resolution, typeof parsed.content === 'string' ? parsed.content : undefined);
      if (!resolved) jsonReply(res, 404, { error: '冲突不存在或已处理。' });
      else jsonReply(res, 200, { ok: true, conflict: resolved });
    } catch (error: unknown) { jsonReply(res, 400, { error: (error as Error).message || '冲突处理失败。' }); }
    return true;
  }
  return false;
}
