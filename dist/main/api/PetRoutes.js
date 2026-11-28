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
exports.handlePetRoute = handlePetRoute;
// =============================================================================
// iExA - Desktop pet routes
//
//   GET    /api/pet                  snapshot: sprite size, version, config
//   GET    /api/pet/sprite           the cut-out PNG (cache-busted by version)
//   GET    /api/pet/model            u2netp.onnx for the renderer's remover
//   POST   /api/pet/sprite           replace the sprite with a PNG body
//   PATCH  /api/pet                  behaviour config
//   DELETE /api/pet/sprite           forget the sprite
// =============================================================================
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const HttpServer_1 = require("./HttpServer");
const PetWindowHost_1 = require("../pet/PetWindowHost");
/**
 * u2netp ships with the app. Cover the dev tree, a portable copy and the
 * packaged `resources/` layout; an empty string means the model is missing and
 * the route reports that instead of streaming a broken file.
 */
function resolvePetModelPath() {
    const resourcesPath = process.resourcesPath || '';
    const candidates = [
        path.resolve(__dirname, '..', '..', '..', 'resources', 'pet', 'u2netp.onnx'),
        path.resolve(process.cwd(), 'resources', 'pet', 'u2netp.onnx'),
        path.resolve(resourcesPath, 'pet', 'u2netp.onnx'),
    ];
    return candidates.find((candidate) => {
        try {
            return fs.statSync(candidate).size > 0;
        }
        catch {
            return false;
        }
    }) || '';
}
const MODEL_PATH = resolvePetModelPath();
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
async function handlePetRoute(req, res, url, ctx) {
    if (!url.pathname.startsWith('/api/pet'))
        return false;
    const { store } = ctx;
    // ---- sprite bytes ------------------------------------------------------
    if (url.pathname === '/api/pet/sprite') {
        if (req.method === 'GET') {
            if (!store.hasSprite()) {
                (0, HttpServer_1.jsonReply)(res, 404, { error: '还没有设置精灵图' });
                return true;
            }
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
            const body = await (0, HttpServer_1.readRawBody)(req, ctx.maxSpriteBytes);
            if (body.length < 8 || !body.subarray(0, 8).equals(PNG_SIGNATURE)) {
                (0, HttpServer_1.jsonReply)(res, 400, { error: '精灵图必须是 PNG' });
                return true;
            }
            try {
                const size = store.writeSprite(body);
                (0, PetWindowHost_1.petWindowHost)()?.applyConfig();
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true, width: size.width, height: size.height, snapshot: store.snapshot() });
            }
            catch (error) {
                (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
            }
            return true;
        }
        if (req.method === 'DELETE') {
            store.clearSprite();
            (0, PetWindowHost_1.petWindowHost)()?.setVisible(false);
            (0, HttpServer_1.jsonReply)(res, 200, { ok: true, snapshot: store.snapshot() });
            return true;
        }
        (0, HttpServer_1.jsonReply)(res, 405, { error: 'method not allowed' });
        return true;
    }
    // ---- segmentation model ------------------------------------------------
    if (url.pathname === '/api/pet/model' && req.method === 'GET') {
        if (!MODEL_PATH || !fs.existsSync(MODEL_PATH)) {
            (0, HttpServer_1.jsonReply)(res, 404, { error: '缺少抠图模型' });
            return true;
        }
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
            (0, HttpServer_1.jsonReply)(res, 200, store.snapshot());
            return true;
        }
        if (req.method === 'PATCH') {
            try {
                const raw = await (0, HttpServer_1.readRawBody)(req, 64 * 1024);
                const body = JSON.parse(raw.toString('utf8') || '{}');
                const config = store.updateConfig(body);
                const host = (0, PetWindowHost_1.petWindowHost)();
                if (host) {
                    if (config.visible)
                        host.setVisible(true);
                    else
                        host.setVisible(false);
                    host.applyConfig();
                }
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true, config, snapshot: store.snapshot() });
            }
            catch (error) {
                (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
            }
            return true;
        }
        (0, HttpServer_1.jsonReply)(res, 405, { error: 'method not allowed' });
        return true;
    }
    (0, HttpServer_1.jsonReply)(res, 404, { error: 'not found' });
    return true;
}
//# sourceMappingURL=PetRoutes.js.map