// =============================================================================
// IEXA - Desktop pet store
//
// One sprite plus a small behaviour config per workspace. The sprite is the
// already-cut-out PNG the renderer produced; this module never touches pixels,
// it only owns the files and the settings that survive a restart.
// =============================================================================
import * as fs from 'fs';
import * as path from 'path';

export interface PetConfig {
  /** Pet window is on screen. */
  visible: boolean;
  /** 0.5–2, multiplies the sprite's natural pixel size. */
  scale: number;
  /** Keep the pet above other windows. */
  alwaysOnTop: boolean;
  /** Drift to a new spot every so often. */
  wander: boolean;
  /** Soft drop shadow under the sprite. */
  shadow: boolean;
  /** Speech bubble on click. */
  reactions: boolean;
}

export interface PetSnapshot {
  hasSprite: boolean;
  spriteVersion: string;
  width: number;
  height: number;
  config: PetConfig;
}

const DEFAULT_CONFIG: PetConfig = {
  visible: false,
  scale: 1,
  alwaysOnTop: true,
  wander: true,
  shadow: true,
  reactions: true,
};

const SCALE_MIN = 0.5;
const SCALE_MAX = 2;

function clampScale(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CONFIG.scale;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(number * 100) / 100));
}

export function normalizePetConfig(raw: unknown): PetConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const flag = (key: keyof PetConfig, fallback: boolean) =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : fallback;
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
function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export class PetStore {
  private readonly configPath: string;
  private readonly spritePath: string;
  private config: PetConfig = { ...DEFAULT_CONFIG };
  /** Bumped on every write: two replacements inside one millisecond must still
   *  produce a new URL, or the window keeps the cached image. */
  private writeSeq = 0;

  constructor(private readonly dir: string) {
    this.configPath = path.join(dir, 'config.json');
    this.spritePath = path.join(dir, 'sprite.png');
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      this.config = normalizePetConfig(raw);
    } catch {
      this.config = { ...DEFAULT_CONFIG };
    }
    // A missing sprite must never leave a window floating with nothing in it.
    if (!this.hasSprite()) this.config.visible = false;
  }

  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const temp = `${this.configPath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.config, null, 2), 'utf8');
    fs.renameSync(temp, this.configPath);
  }

  hasSprite(): boolean {
    try {
      return fs.statSync(this.spritePath).size > 0;
    } catch {
      return false;
    }
  }

  spritePathname(): string {
    return this.spritePath;
  }

  spriteSize(): { width: number; height: number } {
    try {
      return pngSize(fs.readFileSync(this.spritePath)) || { width: 0, height: 0 };
    } catch {
      return { width: 0, height: 0 };
    }
  }

  /** Content stamp so the renderer can cache-bust without polling the file. */
  spriteVersion(): string {
    try {
      const stat = fs.statSync(this.spritePath);
      return `${stat.size}-${Math.round(stat.mtimeMs)}-${this.writeSeq}`;
    } catch {
      return '0-0-0';
    }
  }

  getConfig(): PetConfig {
    return { ...this.config };
  }

  snapshot(): PetSnapshot {
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
  writeSprite(bytes: Buffer): { width: number; height: number } {
    const size = pngSize(bytes);
    if (!size) throw new Error('精灵图必须是 PNG');
    if (size.width < 16 || size.height < 16) throw new Error('精灵图太小');
    if (size.width > 2048 || size.height > 2048) throw new Error('精灵图不能超过 2048×2048');
    fs.mkdirSync(this.dir, { recursive: true });
    const temp = `${this.spritePath}.tmp`;
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, this.spritePath);
    this.writeSeq += 1;
    return size;
  }

  updateConfig(patch: unknown): PetConfig {
    const merged = normalizePetConfig({ ...this.config, ...(patch && typeof patch === 'object' ? patch : {}) });
    if (!this.hasSprite()) merged.visible = false;
    this.config = merged;
    this.save();
    return this.getConfig();
  }

  /** Remove the sprite and hide the pet; settings are kept. */
  clearSprite(): void {
    try {
      fs.rmSync(this.spritePath, { force: true });
    } catch { /* already gone */ }
    this.config.visible = false;
    this.save();
  }
}
