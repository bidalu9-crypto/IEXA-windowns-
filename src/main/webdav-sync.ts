// =============================================================================
// IEXA PC - WebDAV Sync Module
// Syncs settings & conversations to a WebDAV server
// =============================================================================

import { createClient, WebDAVClient } from 'webdav';
import * as fs from 'fs';
import * as path from 'path';

// ---- Types ----
export interface WebDAVConfig {
  url: string;
  username: string;
  password: string;
  enabled: boolean;
  autoSync: boolean;
  lastSync: number;
}

export interface SyncResult {
  ok: boolean;
  uploaded: number;
  downloaded: number;
  error?: string;
}

// ---- Config I/O ----
const CONFIG_FILE: string = (() => {
  // We'll be called from server.ts context; resolve workspace dir
  return '';
})();

let _configFile = '';

export function setConfigFile(filePath: string) {
  _configFile = filePath;
}

export function loadConfig(): WebDAVConfig {
  try {
    if (fs.existsSync(_configFile)) {
      return JSON.parse(fs.readFileSync(_configFile, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { url: '', username: '', password: '', enabled: false, autoSync: false, lastSync: 0 };
}

export function saveConfig(c: WebDAVConfig): void {
  fs.writeFileSync(_configFile, JSON.stringify(c, null, 2), 'utf-8');
}

// ---- Client ----
function createWebDAVClient(cfg: WebDAVConfig): WebDAVClient {
  return createClient(cfg.url, {
    username: cfg.username,
    password: cfg.password,
  });
}

// ---- Test Connection ----
export async function testConnection(cfg: WebDAVConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = createWebDAVClient(cfg);
    await client.getDirectoryContents('/');
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ---- Sync ----
const REMOTE_BASE = '/IEXA';
const SESSIONS_DIR = 'sessions';

export async function syncAll(
  cfg: WebDAVConfig,
  workspaceDir: string,
  sessionsDir: string,
  settingsFile: string,
  sessionsStoreFile: string,
): Promise<SyncResult> {
  const client = createWebDAVClient(cfg);
  let uploaded = 0;
  let downloaded = 0;

  try {
    // Ensure remote base dirs exist
    await ensureRemoteDir(client, REMOTE_BASE);
    await ensureRemoteDir(client, `${REMOTE_BASE}/${SESSIONS_DIR}`);

    // ---- Sync settings file ----
    const remoteSettingsPath = `${REMOTE_BASE}/settings.json`;
    if (fs.existsSync(settingsFile)) {
      const localStat = fs.statSync(settingsFile);
      const localTime = localStat.mtimeMs;
      const remoteTime = await getRemoteMtime(client, remoteSettingsPath);

      if (remoteTime === 0 || localTime > remoteTime) {
        // Upload local → remote
        const content = fs.readFileSync(settingsFile, 'utf-8');
        await client.putFileContents(remoteSettingsPath, content, { overwrite: true });
        uploaded++;
      } else if (remoteTime > localTime) {
        // Download remote → local
        const content = await client.getFileContents(remoteSettingsPath, { format: 'text' }) as string;
        fs.writeFileSync(settingsFile, content, 'utf-8');
        downloaded++;
      }
    }

    // ---- Sync sessions store file ----
    const remoteSessionsStorePath = `${REMOTE_BASE}/sessions-store.json`;
    if (fs.existsSync(sessionsStoreFile)) {
      const localStat = fs.statSync(sessionsStoreFile);
      const localTime = localStat.mtimeMs;
      const remoteTime = await getRemoteMtime(client, remoteSessionsStorePath);

      if (remoteTime === 0 || localTime > remoteTime) {
        const content = fs.readFileSync(sessionsStoreFile, 'utf-8');
        await client.putFileContents(remoteSessionsStorePath, content, { overwrite: true });
        uploaded++;
      } else if (remoteTime > localTime) {
        const content = await client.getFileContents(remoteSessionsStorePath, { format: 'text' }) as string;
        fs.writeFileSync(sessionsStoreFile, content, 'utf-8');
        downloaded++;
      }
    }

    // ---- Sync individual session files ----
    if (fs.existsSync(sessionsDir)) {
      const localFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));

      for (const f of localFiles) {
        const localPath = path.join(sessionsDir, f);
        const remotePath = `${REMOTE_BASE}/${SESSIONS_DIR}/${f}`;
        const localStat = fs.statSync(localPath);
        const localTime = localStat.mtimeMs;
        const remoteTime = await getRemoteMtime(client, remotePath);

        if (remoteTime === 0 || localTime > remoteTime) {
          const content = fs.readFileSync(localPath, 'utf-8');
          await client.putFileContents(remotePath, content, { overwrite: true });
          uploaded++;
        } else if (remoteTime > localTime) {
          const content = await client.getFileContents(remotePath, { format: 'text' }) as string;
          fs.writeFileSync(localPath, content, 'utf-8');
          downloaded++;
        }
      }

      // Also pull remote session files not present locally
      const remoteEntries = await client.getDirectoryContents(`${REMOTE_BASE}/${SESSIONS_DIR}`) as any[];
      for (const entry of remoteEntries) {
        if (entry.type === 'file' && entry.basename && entry.basename.endsWith('.json')) {
          const remotePath = `${REMOTE_BASE}/${SESSIONS_DIR}/${entry.basename}`;
          const localPath = path.join(sessionsDir, entry.basename);
          if (!fs.existsSync(localPath)) {
            try {
              const content = await client.getFileContents(remotePath, { format: 'text' }) as string;
              fs.writeFileSync(localPath, content, 'utf-8');
              downloaded++;
            } catch { /* skip unreachable files */ }
          }
        }
      }
    }

    // Update last sync time
    cfg.lastSync = Date.now();
    saveConfig(cfg);

    return { ok: true, uploaded, downloaded };
  } catch (err: any) {
    return { ok: false, uploaded, downloaded, error: err.message || String(err) };
  }
}

// ---- Helpers ----
async function ensureRemoteDir(client: WebDAVClient, dirPath: string): Promise<void> {
  try {
    const exists = await client.exists(dirPath);
    if (!exists) {
      // Create directory path piece by piece
      const parts = dirPath.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current += '/' + part;
        const ex = await client.exists(current);
        if (!ex) {
          await client.createDirectory(current);
        }
      }
    }
  } catch {
    // If cannot check, try to create (might already exist)
    try { await client.createDirectory(dirPath); } catch { /* ignore */ }
  }
}

async function getRemoteMtime(client: WebDAVClient, remotePath: string): Promise<number> {
  try {
    const stat: any = await client.stat(remotePath);
    if (stat && stat.lastmod) {
      return new Date(stat.lastmod).getTime();
    }
  } catch { /* file likely doesn't exist */ }
  return 0;
}
