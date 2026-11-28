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
exports.PetStore = void 0;
exports.normalizePetConfig = normalizePetConfig;
// =============================================================================
// iExA - Desktop pet store
//
// One sprite plus a small behaviour config per workspace. The sprite is the
// already-cut-out PNG the renderer produced; this module never touches pixels,
// it only owns the files and the settings that survive a restart.
// =============================================================================
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const stripBom_1 = require("../persistence/stripBom");
const DEFAULT_CONFIG = {
    visible: false,
    scale: 1,
    alwaysOnTop: true,
    wander: true,
    shadow: true,
    reactions: true,
};
const SCALE_MIN = 0.5;
const SCALE_MAX = 2;
function clampScale(value) {
    const number = Number(value);
    if (!Number.isFinite(number))
        return DEFAULT_CONFIG.scale;
    return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(number * 100) / 100));
}
function normalizePetConfig(raw) {
    const source = (raw && typeof raw === 'object' ? raw : {});
    const flag = (key, fallback) => typeof source[key] === 'boolean' ? source[key] : fallback;
    return {
        visible: flag('visible', DEFAULT_CONFIG.visible),
        scale: clampScale(source.scale ?? DEFAULT_CONFIG.scale),
        alwaysOnTop: flag('alwaysOnTop', DEFAULT_CONFIG.alwaysOnTop),
        wander: flag('wander', DEFAULT_CONFIG.wander),
        shadow: flag('shadow', DEFAULT_CONFIG.shadow),
        reactions: flag('reactions', DEFAULT_CONFIG.reactions),
    };
}
/** PNG header: width and height live at bytes 16..23, big endian. */
function pngSize(buffer) {
    if (buffer.length < 24)
        return null;
    if (buffer.readUInt32BE(0) !== 0x89504e47)
        return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
class PetStore {
    dir;
    configPath;
    spritePath;
    config = { ...DEFAULT_CONFIG };
    /** Bumped on every write: two replacements inside one millisecond must still
     *  produce a new URL, or the window keeps the cached image. */
    writeSeq = 0;
    constructor(dir) {
        this.dir = dir;
        this.configPath = path.join(dir, 'config.json');
        this.spritePath = path.join(dir, 'sprite.png');
        this.load();
    }
    load() {
        try {
            const raw = JSON.parse((0, stripBom_1.stripBom)(fs.readFileSync(this.configPath, 'utf8')));
            this.config = normalizePetConfig(raw);
        }
        catch {
            this.config = { ...DEFAULT_CONFIG };
        }
        // A missing sprite must never leave a window floating with nothing in it.
        if (!this.hasSprite())
            this.config.visible = false;
    }
    save() {
        fs.mkdirSync(this.dir, { recursive: true });
        const temp = `${this.configPath}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(this.config, null, 2), 'utf8');
        fs.renameSync(temp, this.configPath);
    }
    hasSprite() {
        try {
            return fs.statSync(this.spritePath).size > 0;
        }
        catch {
            return false;
        }
    }
    spritePathname() {
        return this.spritePath;
    }
    spriteSize() {
        try {
            return pngSize(fs.readFileSync(this.spritePath)) || { width: 0, height: 0 };
        }
        catch {
            return { width: 0, height: 0 };
        }
    }
    /** Content stamp so the renderer can cache-bust without polling the file. */
    spriteVersion() {
        try {
            const stat = fs.statSync(this.spritePath);
            return `${stat.size}-${Math.round(stat.mtimeMs)}-${this.writeSeq}`;
        }
        catch {
            return '0-0-0';
        }
    }
    getConfig() {
        return { ...this.config };
    }
    snapshot() {
        const size = this.spriteSize();
        return {
            hasSprite: this.hasSprite(),
            spriteVersion: this.spriteVersion(),
            width: size.width,
            height: size.height,
            config: this.getConfig(),
        };
    }
    /** Replace the sprite. The caller already validated it is a PNG. */
    writeSprite(bytes) {
        const size = pngSize(bytes);
        if (!size)
            throw new Error('精灵图必须是 PNG');
        if (size.width < 16 || size.height < 16)
            throw new Error('精灵图太小');
        if (size.width > 2048 || size.height > 2048)
            throw new Error('精灵图不能超过 2048×2048');
        fs.mkdirSync(this.dir, { recursive: true });
        const temp = `${this.spritePath}.tmp`;
        fs.writeFileSync(temp, bytes);
        fs.renameSync(temp, this.spritePath);
        this.writeSeq += 1;
        return size;
    }
    updateConfig(patch) {
        const merged = normalizePetConfig({ ...this.config, ...(patch && typeof patch === 'object' ? patch : {}) });
        if (!this.hasSprite())
            merged.visible = false;
        this.config = merged;
        this.save();
        return this.getConfig();
    }
    /** Remove the sprite and hide the pet; settings are kept. */
    clearSprite() {
        try {
            fs.rmSync(this.spritePath, { force: true });
        }
        catch { /* already gone */ }
        this.config.visible = false;
        this.save();
    }
}
exports.PetStore = PetStore;
//# sourceMappingURL=PetStore.js.map