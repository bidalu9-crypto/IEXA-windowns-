// =============================================================================
// IEXA - Desktop pet routes
//
//   GET    /api/pet                  snapshot: sprite size, version, config
//   GET    /api/pet/sprite           the cut-out PNG (cache-busted by version)
//   GET    /api/pet/model            u2netp.onnx for the renderer's remover
//   POST   /api/pet/sprite           replace the sprite with a PNG body
//   PATCH  /api/pet                  behaviour config
//   DELETE /api/pet/sprite           forget the sprite
// =============================================================================
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { URL } from 'url';
import { jsonReply, readRawBody } from './HttpServer';
import { PetStore } from '../pet/PetStore';
import { petWindowHost } from '../pet/PetWindowHost';

export interface PetRouteContext {
  store: PetStore;
  maxSpriteBytes: number;
}

/**
 * u2netp ships with the app. Cover the dev tree, a portable copy and the
 * packaged `resources/` layout; an empty string means the model is missing and
 * the route reports that instead of streaming a broken file.
 */
function resolvePetModelPath(): string {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath || '';
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'resources', 'pet', 'u2netp.onnx'),
    path.resolve(process.cwd(), 'resources', 'pet', 'u2netp.onnx'),
    path.resolve(resourcesPath, 'pet', 'u2netp.onnx'),
  ];
  return candidates.find((candidate) => {
    try { return fs.statSync(candidate).size > 0; } catch { return false; }
  }) || '';
}

const MODEL_PATH = resolvePetModelPath();

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function handlePetRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: PetRouteContext,
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/pet')) return false;
  const { store } = ctx;

  // ---- sprite bytes ------------------------------------------------------
  if (url.pathname === '/api/pet/sprite') {
    if (req.method === 'GET') {
      if (!store.hasSprite()) { jsonReply(res, 404, { error: '还没有设置精灵图' }); return true; }
      const bytes = fs.readFileSync(store.spritePathname());
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': bytes.length,
        // The version is in the query string; a long max-age is safe because a
        // replacement bumps that version.
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(bytes);
      return true;
    }
    if (req.method === 'POST') {
      const body = await readRawBody(req, ctx.maxSpriteBytes);
      if (body.length < 8 || !body.subarray(0, 8).equals(PNG_SIGNATURE)) {
        jsonReply(res, 400, { error: '精灵图必须是 PNG' });
        return true;
      }
      try {
        const size = store.writeSprite(body);
        petWindowHost()?.applyConfig();
        jsonReply(res, 200, { ok: true, width: size.width, height: size.height, snapshot: store.snapshot() });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return true;
    }
    if (req.method === 'DELETE') {
      store.clearSprite();
      petWindowHost()?.setVisible(false);
      jsonReply(res, 200, { ok: true, snapshot: store.snapshot() });
      return true;
    }
    jsonReply(res, 405, { error: 'method not allowed' });
    return true;
  }

  // ---- segmentation model ------------------------------------------------
  if (url.pathname === '/api/pet/model' && req.method === 'GET') {
    if (!MODEL_PATH || !fs.existsSync(MODEL_PATH)) { jsonReply(res, 404, { error: '缺少抠图模型' }); return true; }
    const stat = fs.statSync(MODEL_PATH);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(MODEL_PATH).pipe(res);
    return true;
  }

  // ---- snapshot + config -------------------------------------------------
  if (url.pathname === '/api/pet') {
    if (req.method === 'GET') {
      jsonReply(res, 200, store.snapshot());
      return true;
    }
    if (req.method === 'PATCH') {
      try {
        const raw = await readRawBody(req, 64 * 1024);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const config = store.updateConfig(body);
        const host = petWindowHost();
        if (host) {
          if (config.visible) host.setVisible(true);
          else host.setVisible(false);
          host.applyConfig();
        }
        jsonReply(res, 200, { ok: true, config, snapshot: store.snapshot() });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return true;
    }
    jsonReply(res, 405, { error: 'method not allowed' });
    return true;
  }

  jsonReply(res, 404, { error: 'not found' });
  return true;
}
