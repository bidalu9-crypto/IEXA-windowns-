/**
 * File, attachment and artifact serving.
 *
 * These are the only routes that push bytes straight from disk to the socket,
 * so the rules that make that safe live here together: every path goes through
 * PathSandbox, private files (.iexa-*, .env, .git, .ssh) are refused even when
 * they resolve inside a permitted root, and HTML delivered for preview gets a
 * sandbox CSP plus the scroll/error channel the live preview needs.
 *
 * Each handler reports whether it recognised the request, so server.ts keeps a
 * single dispatch point instead of one if-chain per feature.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { URL } from 'url';
import { jsonReply, readBody, HttpError, handleHttpError } from './HttpServer';
import { resolveScopedPath } from '../security/PathSandbox';
import { searchProjectText } from '../search/ProjectSearch';

export interface RegisteredArtifact {
  path: string;
  mimeType: string;
  size: number;
  created: number;
}

export interface FileRouteContext {
  workspaceDir: string;
  /** Root of the project currently open in the workbench, if any. */
  getProjectRoot(): string | null;
  /** Project roots of every stored session, for read-only artifact access. */
  sessionProjectRoots(): string[];
  artifacts: Map<string, RegisteredArtifact>;
}

// ---- MIME ----
export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.ogv': 'video/ogg', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

export function isPrivateFile(file: string): boolean {
  return file.split(/[\\/]/).some(part => /^\.iexa-/i.test(part) || /^\.env(?:\.|$)/i.test(part) || ['.ssh', '.git'].includes(part.toLowerCase()));
}

function applyPreviewIsolation(res: http.ServerResponse, extension: string): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (['.html', '.htm', '.svg', '.xhtml', '.xml'].includes(extension)) {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  }
}

/**
 * Channel injected into live preview documents.
 *
 * The preview iframe is sandboxed with allow-scripts but deliberately without
 * allow-same-origin, so the host page can never reach into it. That isolation
 * is what makes previewing generated HTML safe, and it is also why the frame
 * has to report its own scroll position and runtime errors: postMessage is the
 * only thing that crosses the boundary. The parent never trusts this data for
 * anything but presentation.
 */
const PREVIEW_RUNTIME = `<script data-iexa-runtime="1">
(function () {
  if (window.__iexaPreviewRuntime) return;
  window.__iexaPreviewRuntime = 1;
  function send(message) {
    message.__iexaPreview = 1;
    try { parent.postMessage(message, '*'); } catch (error) { /* frame is gone */ }
  }
  function report(type) {
    send({
      type: type,
      title: document.title || '',
      scrollY: window.scrollY || window.pageYOffset || 0,
      height: document.documentElement ? document.documentElement.scrollHeight : 0,
    });
  }
  var queued = 0;
  window.addEventListener('scroll', function () {
    if (queued) return;
    queued = requestAnimationFrame(function () { queued = 0; report('scroll'); });
  }, { passive: true });
  window.addEventListener('error', function (event) {
    send({
      type: 'error',
      message: String(event.message || 'Script error'),
      source: String(event.filename || ''),
      line: event.lineno || 0,
    });
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    send({ type: 'error', message: 'Unhandled rejection: ' + (reason && reason.message ? reason.message : String(reason)) });
  });
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.__iexaPreviewCommand !== 1) return;
    if (data.type === 'scroll') window.scrollTo(0, Math.max(0, Number(data.y) || 0));
    else if (data.type === 'report') report('ready');
  });
  if (document.readyState === 'complete') report('ready');
  else window.addEventListener('load', function () { report('ready'); });
})();
</script>`;

const PREVIEW_RUNTIME_MAX_BYTES = 16 * 1024 * 1024;

function injectPreviewRuntime(html: string): string {
  // Inject as early as the document allows: a page that throws in its own
  // <head> scripts must still be reported, so appending before </body> is too
  // late. Stay behind the charset declaration and the <head> tag so encoding
  // sniffing and parser state are untouched.
  const head = /<head[^>]*>/i.exec(html);
  const charset = /<meta[^>]+charset[^>]*>/i.exec(html);
  let at = head ? head.index + head[0].length : -1;
  if (charset && charset.index < 4096) at = Math.max(at, charset.index + charset[0].length);
  if (at < 0) {
    const body = /<body[^>]*>/i.exec(html);
    at = body ? body.index + body[0].length : 0;
  }
  return `${html.slice(0, at)}${PREVIEW_RUNTIME}${html.slice(at)}`;
}

function scopedArtifact(file: string, ctx: FileRouteContext): string | null {
  const sessionRoots = ctx.sessionProjectRoots();
  const roots = [...new Set([ctx.workspaceDir, ctx.getProjectRoot(), ...sessionRoots].filter((value): value is string => Boolean(value)))];
  try { const safe = resolveScopedPath(file, roots); if (!isPrivateFile(safe)) return safe; } catch {}
  // Only application-generated text artifacts may use the otherwise-private artifact directory.
  if (!/^artifact_[A-Za-z0-9_-]+\.txt$/.test(path.basename(file))) return null;
  for (const root of roots) {
    const directory = path.join(root, '.iexa-artifacts');
    try { const canonicalRoot = fs.realpathSync.native(root); const canonicalDirectory = fs.realpathSync.native(directory); const canonicalFile = fs.realpathSync.native(file);
      if (!fs.lstatSync(directory).isSymbolicLink() && path.dirname(canonicalDirectory) === canonicalRoot && path.dirname(canonicalFile) === canonicalDirectory) return canonicalFile;
    } catch {}
  }
  return null;
}

function pipeFile(file: string, res: http.ServerResponse): void {
  // Headers may already have been sent by the route; set isolation before writeHead.

  const stream = fs.createReadStream(file); stream.once('error', error => handleHttpError(res, error));
  res.once('close', () => stream.destroy()); stream.pipe(res);
}

export function sanitizeFileName(name: string): string {
  const base = path.basename(name || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return base || 'file';
}

/** Resolve a path relative to the active project; block path traversal. */
function resolveProjectPath(rel: string, ctx: FileRouteContext): string | null {
  const root = ctx.getProjectRoot(); if (!root) return null;
  try { return resolveScopedPath(rel || '.', [root]); } catch { return null; }
}

/** Resolve HTML preview files while preserving a virtual directory for relative assets. */
function resolveHtmlPreviewPath(scope: string, requestedPath: string, ctx: FileRouteContext): string | null {
  const project = ctx.getProjectRoot();
  const roots = scope === 'workspace' ? [ctx.workspaceDir] : scope === 'project' ? (project ? [project] : []) : scope === 'absolute' && path.isAbsolute(requestedPath) ? [ctx.workspaceDir, ...(project ? [project] : [])] : [];
  try { const target = resolveScopedPath(requestedPath, roots); return !isPrivateFile(target) && fs.statSync(target).isFile() ? target : null; } catch { return null; }
}

/** Handles /api/fs/*, /api/artifacts/* and /api/attachments/*; false means "not mine". */
export async function handleFileRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: FileRouteContext,
): Promise<boolean> {
    if (url.pathname === '/api/fs/search' && req.method === 'GET') {
      const projectRoot = ctx.getProjectRoot();
      if (!projectRoot) {
        jsonReply(res, 400, { error: '尚未打开项目' });
        return true;
      }
      const query = (url.searchParams.get('q') || '').trim();
      if (query.length < 2) {
        jsonReply(res, 200, { query, results: [], scanned: false });
        return true;
      }
      const requestedLimit = Number(url.searchParams.get('limit') || '100');
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 100;
      jsonReply(res, 200, { query, results: await searchProjectText(projectRoot, query, limit), scanned: true });
      return true;
    }

    // =====================================================================
    // Project file browser (only when a project is open)
    // =====================================================================
    if (url.pathname.startsWith('/api/artifacts/') && req.method === 'GET') {
      applyPreviewIsolation(res, '.html');
      const id = decodeURIComponent(url.pathname.slice('/api/artifacts/'.length));
      const artifact = ctx.artifacts.get(id);
      if (!artifact || !fs.existsSync(artifact.path) || Date.now() - artifact.created > 30 * 60 * 1000) {
        ctx.artifacts.delete(id);
        res.writeHead(404); res.end('artifact not found'); return true;
      }
      const safePath = scopedArtifact(artifact.path, ctx);
      if (!safePath) throw new HttpError(403, '工件路径不在当前授权范围。');
      const stat = fs.statSync(safePath);
      const range = req.headers.range;
      const commonHeaders = {
        'Content-Type': MIME_TYPES[path.extname(safePath).toLowerCase()] || 'application/octet-stream',
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
      };
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
        if (match) {
          const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 0));
          const end = match[2] ? Number(match[2]) : stat.size - 1;
          if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && end < stat.size) {
            res.writeHead(206, {
              ...commonHeaders,
              'Content-Length': end - start + 1,
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            });
            const stream = fs.createReadStream(safePath, { start, end }); stream.once('error', error => handleHttpError(res, error)); res.once('close', () => stream.destroy()); stream.pipe(res);
            return true;
          }
        }
      }
      res.writeHead(200, { ...commonHeaders, 'Content-Length': stat.size });
      pipeFile(safePath, res);
      return true;
    }

    // Cheap change detection for the live preview. The renderer polls this
    // instead of the preview URL so a 20 MB document is not re-downloaded just
    // to discover that nothing changed.
    if (url.pathname.startsWith('/api/fs/preview-stat/') && req.method === 'GET') {
      const encoded = url.pathname.slice('/api/fs/preview-stat/'.length);
      const separator = encoded.indexOf('/');
      const reply = (payload: unknown) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify(payload));
      };
      if (separator < 1) { reply({ exists: false }); return true; }
      try {
        const scope = encoded.slice(0, separator);
        const requestedPath = decodeURIComponent(encoded.slice(separator + 1)).replace(/\//g, path.sep);
        const target = resolveHtmlPreviewPath(scope, requestedPath, ctx);
        if (!target) { reply({ exists: false }); return true; }
        const stat = fs.statSync(target);
        reply({ exists: true, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch { reply({ exists: false }); }
      return true;
    }

    if (url.pathname.startsWith('/api/fs/preview/') && req.method === 'GET') {
      try {
        const encoded = url.pathname.slice('/api/fs/preview/'.length);
        const separator = encoded.indexOf('/');
        if (separator < 1) {
          res.writeHead(404); res.end('预览文件不存在'); return true;
        }
        const scope = encoded.slice(0, separator);
        const requestedPath = decodeURIComponent(encoded.slice(separator + 1)).replace(/\//g, path.sep);
        const target = resolveHtmlPreviewPath(scope, requestedPath, ctx);
        if (!target) {
          res.writeHead(404); res.end('预览文件不存在'); return true;
        }
        const ext = path.extname(target).toLowerCase();
        applyPreviewIsolation(res, ext);
        const commonHeaders = {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Content-Disposition': 'inline',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        };
        // Only the top-level HTML document gets the runtime. Subresources keep
        // streaming straight from disk.
        if (url.searchParams.get('iexa_runtime') === '1' && (ext === '.html' || ext === '.htm')) {
          const stat = fs.statSync(target);
          if (stat.size <= PREVIEW_RUNTIME_MAX_BYTES) {
            const source = fs.readFileSync(target, 'utf8');
            // The runtime is injected as UTF-8 text and the response is served
            // as UTF-8, so only touch documents that are already UTF-8 (or pure
            // ASCII, which is identical in every ASCII-compatible encoding).
            // Anything else is streamed untouched; it simply loses the scroll
            // and error channel, never its bytes.
            const declared = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(source.slice(0, 4096));
            const charset = declared ? declared[1].toLowerCase() : '';
            const utf8Safe = charset === 'utf-8' || charset === 'utf8'
              || (!charset && !/[\u0080-\uFFFF]/.test(source));
            if (utf8Safe) {
              const document = injectPreviewRuntime(source);
              const body = Buffer.from(document, 'utf8');
              res.writeHead(200, {
                ...commonHeaders,
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': body.length,
              });
              res.end(body);
              return true;
            }
          }
        }
        res.writeHead(200, commonHeaders);
        pipeFile(target, res);
      } catch {
        res.writeHead(400); res.end('预览路径无效');
      }
      return true;
    }

    if (url.pathname === '/api/fs/raw' && req.method === 'GET') {
      try {
        const projectRoot = ctx.getProjectRoot();
        const rel = (url.searchParams.get('path') || '').replace(/\\/g, '/');
        const base = projectRoot || ctx.workspaceDir;
        let target: string | null;
        try { target = resolveScopedPath(rel || '.', [base]); } catch { target = null; }
        if (target && isPrivateFile(target)) target = null;
        if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          res.writeHead(404); res.end('文件不存在'); return true;
        }
        const ext = path.extname(target).toLowerCase();
        applyPreviewIsolation(res, ext);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Content-Disposition': 'inline; filename="' + sanitizeFileName(path.basename(target)) + '"',
          'Cache-Control': 'no-store',
        });
        pipeFile(target, res);
      } catch { res.writeHead(400); res.end('无法读取文件'); }
      return true;
    }

    if (url.pathname.startsWith('/api/attachments/') && req.method === 'GET') {
      applyPreviewIsolation(res, '.html');
      const parts = url.pathname.split('/').filter(Boolean);
      const sid = parts[2] || '';
      const name = sanitizeFileName(decodeURIComponent(parts.slice(3).join('/')));
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sid) || !name) throw new HttpError(404, '附件不存在。');
      const uploadRoot = path.resolve(ctx.workspaceDir, 'uploads', sid);
      let target: string;
      try { target = resolveScopedPath(name, [uploadRoot]); } catch { throw new HttpError(404, '附件不存在。'); }
      const rel = path.relative(fs.realpathSync.native(uploadRoot), target);
      if (!sid || !name || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(target)) {
        res.writeHead(404); res.end('附件不存在'); return true;
      }
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Disposition': 'inline; filename="' + name + '"',
        'Cache-Control': 'no-store',
      });
      pipeFile(target, res);
      return true;
    }

    if (url.pathname === '/api/fs/list' && req.method === 'GET') {
      try {
        const projectRoot = ctx.getProjectRoot();
        if (!projectRoot) {
          jsonReply(res, 200, { root: null, path: '.', entries: [], empty: true });
          return true;
        }
        const rel = (url.searchParams.get('path') || '.').replace(/\\/g, '/');
        const target = resolveProjectPath(rel, ctx);
        if (target && isPrivateFile(target)) { jsonReply(res, 403, { error: '应用内部或秘密文件不在展示范围。' }); return true; }
        if (!target) {
          jsonReply(res, 400, { error: '路径无效' });
          return true;
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
          jsonReply(res, 404, { error: '目录不存在' });
          return true;
        }
        const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);
        const entries = fs.readdirSync(target, { withFileTypes: true })
          .filter((d) => {
            if (d.name === '.' || d.name === '..' || isPrivateFile(path.join(target, d.name))) return false;
            if (d.name.startsWith('.') && d.name !== '.env' && d.name !== '.gitignore') return false;
            if (SKIP.has(d.name)) return false;
            return true;
          })
          .map((d) => {
            const full = path.join(target, d.name);
            let size = 0;
            let mtime = 0;
            try {
              const st = fs.statSync(full);
              size = st.size;
              mtime = st.mtimeMs;
            } catch { /* */ }
            const isDir = d.isDirectory();
            const relPath = path.relative(projectRoot, full).replace(/\\/g, '/') || '.';
            return {
              name: d.name,
              type: isDir ? 'dir' : 'file',
              size,
              mtime,
              path: relPath,
            };
          })
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name, 'zh-CN');
          });

        const relNorm = path.relative(projectRoot, target).replace(/\\/g, '/') || '.';
        jsonReply(res, 200, {
          root: projectRoot,
          name: path.basename(projectRoot),
          path: relNorm,
          entries,
          empty: false,
        });
      } catch (err) {
        jsonReply(res, 500, { error: (err as Error).message });
      }
      return true;
    }

    if (url.pathname === '/api/fs/read' && req.method === 'GET') {
      try {
        const projectRoot = ctx.getProjectRoot();
        if (!projectRoot) {
          jsonReply(res, 400, { error: '尚未打开项目' });
          return true;
        }
        const rel = (url.searchParams.get('path') || '').replace(/\\/g, '/');
        const target = resolveProjectPath(rel, ctx);
        if (target && isPrivateFile(target)) { jsonReply(res, 403, { error: '应用内部或秘密文件不在展示范围。' }); return true; }
        if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          jsonReply(res, 404, { error: '文件不存在' });
          return true;
        }
        const st = fs.statSync(target);
        if (st.size > 512 * 1024) {
          jsonReply(res, 400, { error: '文件过大（>512KB），请用对话工具读取' });
          return true;
        }
        const buf = fs.readFileSync(target);
        const sample = buf.subarray(0, Math.min(8000, buf.length));
        let nulls = 0;
        for (let i = 0; i < sample.length; i++) if (sample[i] === 0) nulls++;
        if (nulls > 0) {
          jsonReply(res, 400, { error: '二进制文件，无法预览' });
          return true;
        }
        let text = buf.toString('utf-8');
        if (text.length > 80000) text = text.substring(0, 80000) + '\n\n…（已截断）';
        jsonReply(res, 200, {
          path: path.relative(projectRoot, target).replace(/\\/g, '/'),
          name: path.basename(target),
          size: st.size,
          content: text,
        });
      } catch (err) {
        jsonReply(res, 500, { error: (err as Error).message });
      }
      return true;
    }

    if (url.pathname === '/api/fs/delete' && req.method === 'POST') {
      try {
        const projectRoot = ctx.getProjectRoot();
        if (!projectRoot) {
          jsonReply(res, 400, { error: '尚未打开项目' });
          return true;
        }
        const body = await readBody(req);
        let rel = '';
        try { rel = (JSON.parse(body).path || '').replace(/\\/g, '/'); } catch { /* */ }
        const target = resolveProjectPath(rel, ctx);
        if (target && isPrivateFile(target)) { jsonReply(res, 403, { error: '应用内部或秘密文件不在展示范围。' }); return true; }
        if (!target) {
          jsonReply(res, 400, { error: '路径无效' });
          return true;
        }
        if (path.relative(projectRoot, target) === '' || path.relative(projectRoot, target) === '.') {
          jsonReply(res, 400, { error: '不能删除项目根目录' });
          return true;
        }
        if (!fs.existsSync(target)) {
          jsonReply(res, 404, { error: '文件不存在' });
          return true;
        }
        const st = fs.statSync(target);
        if (st.isDirectory()) {
          fs.rmSync(target, { recursive: true, force: true });
        } else {
          fs.unlinkSync(target);
        }
        jsonReply(res, 200, { ok: true });
      } catch (err) {
        jsonReply(res, 500, { error: (err as Error).message });
      }
      return true;
    }
  return false;
}
