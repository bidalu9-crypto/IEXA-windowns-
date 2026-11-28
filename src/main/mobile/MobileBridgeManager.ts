import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { JsonStore } from '../persistence/JsonStore';

export type MobileCapability = 'chat' | 'files' | 'full';

interface PairedDeviceRecord {
  id: string;
  name: string;
  capability: MobileCapability;
  tokenHash: string;
  createdAt: number;
  lastActiveAt: number;
}

interface MobileBridgeStore {
  enabled: boolean;
  defaultCapability: MobileCapability;
  secret: string;
  devices: PairedDeviceRecord[];
}

interface PairTokenRecord {
  hash: string;
  expiresAt: number;
}

/**
 * One short numeric code at a time, so a phone can pair without a camera.
 * Only the HMAC is kept: a reload cannot recover the digits, and a stolen
 * store file cannot either.
 */
interface PairPinRecord {
  hash: string;
  expiresAt: number;
  attempts: number;
}

export interface MobileBridgeDevice {
  id: string;
  name: string;
  capability: MobileCapability;
  createdAt: number;
  lastActiveAt: number;
}

const PAIR_TOKEN_TTL_MS = 5 * 60 * 1000;
const ACTIVE_WRITE_INTERVAL_MS = 60 * 1000;
/** Four digits is 10k combinations, so a wrong guess spends a try. */
const PAIR_PIN_ATTEMPTS = 5;
const PAIR_PIN_LENGTH = 4;

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function normalizeCapability(value: unknown): MobileCapability {
  return value === 'chat' || value === 'files' || value === 'full' ? value : 'chat';
}

function normalizeStore(value: unknown): MobileBridgeStore {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const devices = Array.isArray(source.devices) ? source.devices : [];
  return {
    enabled: source.enabled === true,
    defaultCapability: normalizeCapability(source.defaultCapability),
    secret: typeof source.secret === 'string' && source.secret.length >= 32 ? source.secret : randomToken(48),
    devices: devices.flatMap((entry): PairedDeviceRecord[] => {
      if (!entry || typeof entry !== 'object') return [];
      const item = entry as Record<string, unknown>;
      if (typeof item.id !== 'string' || typeof item.tokenHash !== 'string') return [];
      return [{
        id: item.id,
        name: String(item.name || '移动设备').slice(0, 80),
        capability: normalizeCapability(item.capability),
        tokenHash: item.tokenHash,
        createdAt: Number(item.createdAt) || Date.now(),
        lastActiveAt: Number(item.lastActiveAt) || Date.now(),
      }];
    }).slice(0, 50),
  };
}

/** Proxy/tunnel fakes that phones can never route to (Clash TUN uses 198.18.0.0/15). */
function isUnroutableFromLan(address: string): boolean {
  if (address.startsWith('169.254.')) return true;
  if (/^198\.1[89]\./.test(address)) return true;
  return false;
}

/**
 * Mirror of the listener's IPv6 filter. A residential prefix renumbers whenever
 * PPPoE reconnects, so pairing codes have to follow whatever address the router
 * is currently advertising instead of a literal baked into start.bat. The
 * rotating RFC 4941 temporary address is still excluded (it is the /128); a
 * code pointing at it would expire within hours.
 */
function isUnusableIpv6(address: string, netmask?: string): boolean {
  const ip = address.toLowerCase();
  if (ip.startsWith('fe80:')) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;
  if (netmask && /^ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff$/i.test(netmask)) return true;
  return false;
}

function networkAddresses(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      if (entry.family === 'IPv4') {
        if (isUnroutableFromLan(entry.address)) continue;
        addresses.add(entry.address);
        continue;
      }
      if (entry.family !== 'IPv6') continue;
      if (isUnusableIpv6(entry.address, entry.netmask)) continue;
      addresses.add(entry.address.toLowerCase());
    }
  }
  return [...addresses];
}

/** Real LAN addresses first so pairing codes never default to a tunnel IP. */
function preferredAddress(): string | undefined {
  const all = networkAddresses();
  return all.find((address) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address))
    || all.find((address) => address.includes(':'))
    || all[0];
}

export class MobileBridgeManager {
  private readonly store: JsonStore<MobileBridgeStore>;
  private state: MobileBridgeStore;
  private pairTokens = new Map<string, PairTokenRecord>();
  private pairPin: PairPinRecord | null = null;
  private port = 0;

  constructor(workspaceDir: string) {
    this.store = new JsonStore<MobileBridgeStore>(path.join(workspaceDir, '.iexa-mobile-bridge.json'), () => normalizeStore({}));
    this.state = normalizeStore(this.store.loadSync());
    this.save();
  }

  setPort(port: number): void {
    this.port = port;
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  status(): { enabled: boolean; defaultCapability: MobileCapability; addresses: string[]; port: number; devices: MobileBridgeDevice[] } {
    return {
      enabled: this.state.enabled,
      defaultCapability: this.state.defaultCapability,
      addresses: networkAddresses(),
      port: this.port,
      devices: this.devices(),
    };
  }

  configure(input: { enabled?: unknown; defaultCapability?: unknown }): ReturnType<MobileBridgeManager['status']> {
    if (typeof input.enabled === 'boolean') this.state.enabled = input.enabled;
    if (input.defaultCapability !== undefined) this.state.defaultCapability = normalizeCapability(input.defaultCapability);
    if (!this.state.enabled) { this.pairTokens.clear(); this.pairPin = null; }
    this.save();
    return this.status();
  }

  createPairToken(address?: string): { token: string; expiresAt: number; url: string } {
    if (!this.state.enabled) throw new Error('请先开启手机桥接。');
    this.pruneTokens();
    const token = randomToken(24);
    const id = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
    const expiresAt = Date.now() + PAIR_TOKEN_TTL_MS;
    this.pairTokens.set(id, { hash: this.hash(`pair:${token}`), expiresAt });
    const host = String(address || preferredAddress() || '').replace(/^\[|\]$/g, '');
    if (host && ![...networkAddresses(), '127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('配对地址不属于本机。');
    if (!host || !this.port) throw new Error('没有检测到可用的局域网地址。');
    // An IPv6 literal must be bracketed in a URL (RFC 3986); 443 is implicit.
    const authority = host.includes(':') ? `[${host}]` : host;
    const portPart = this.port === 443 ? '' : `:${this.port}`;
    return { token, expiresAt, url: `https://${authority}${portPart}/#pair=${encodeURIComponent(token)}` };
  }

  /** Four digits, uniform, no leading-zero bias. Replaces any previous code. */
  createPairPin(): { code: string; expiresAt: number; ttlMs: number } {
    if (!this.state.enabled) throw new Error('请先开启手机桥接。');
    const expiresAt = Date.now() + PAIR_TOKEN_TTL_MS;
    let code = '';
    // crypto.randomInt is rejection-sampled, so every 0000-9999 value is equally
    // likely; Math.random() would leak a modulo bias.
    for (let i = 0; i < PAIR_PIN_LENGTH; i += 1) code += String(crypto.randomInt(0, 10));
    this.pairPin = { hash: this.hash(`pin:${code}`), expiresAt, attempts: 0 };
    return { code, expiresAt, ttlMs: PAIR_TOKEN_TTL_MS };
  }

  /** Whether a usable code exists, without ever revealing it. */
  pairPinState(): { active: boolean; expiresAt: number } {
    this.prunePin();
    return { active: Boolean(this.pairPin), expiresAt: this.pairPin?.expiresAt || 0 };
  }

  /** Null on success, otherwise the reason so the phone can show it. */
  pairWithPin(code: string, name: string): { device: MobileBridgeDevice; sessionToken: string } | { error: string } {
    if (!this.state.enabled) return { error: '电脑端的手机桥接当前已关闭。' };
    this.prunePin();
    const pin = this.pairPin;
    if (!pin) return { error: '验证码已失效，请在电脑端重新生成。' };
    const digits = String(code || '').replace(/\D/g, '').slice(0, PAIR_PIN_LENGTH);
    if (digits.length !== PAIR_PIN_LENGTH) return { error: '请输入完整的四位数字验证码。' };
    if (!this.secureEqual(pin.hash, this.hash(`pin:${digits}`))) {
      // Burn a try so 10k guesses cannot be walked in five minutes.
      pin.attempts += 1;
      if (pin.attempts >= PAIR_PIN_ATTEMPTS) {
        this.pairPin = null;
        return { error: '验证码错误次数过多，请在电脑端重新生成。' };
      }
      return { error: `验证码不正确，还可尝试 ${PAIR_PIN_ATTEMPTS - pin.attempts} 次。` };
    }
    // A code is single-use: it dies the moment it succeeds.
    this.pairPin = null;
    return this.registerDevice(name);
  }

  pair(token: string, name: string): { device: MobileBridgeDevice; sessionToken: string } | null {
    if (!this.state.enabled || !token) return null;
    this.pruneTokens();
    const id = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
    const record = this.pairTokens.get(id);
    if (!record || record.expiresAt < Date.now() || !this.secureEqual(record.hash, this.hash(`pair:${token}`))) return null;
    this.pairTokens.delete(id);
    return this.registerDevice(name);
  }

  /** Shared tail of both pairing paths: mint a session and store the device. */
  private registerDevice(name: string): { device: MobileBridgeDevice; sessionToken: string } {
    const now = Date.now();
    const sessionToken = randomToken(36);
    const device: PairedDeviceRecord = {
      id: crypto.randomUUID(),
      name: String(name || '移动设备').trim().slice(0, 80) || '移动设备',
      capability: this.state.defaultCapability,
      tokenHash: this.hash(`session:${sessionToken}`),
      createdAt: now,
      lastActiveAt: now,
    };
    this.state.devices.unshift(device);
    this.state.devices = this.state.devices.slice(0, 50);
    this.save();
    return { device: this.publicDevice(device), sessionToken };
  }

  /** Forget the current code, e.g. when the desktop panel regenerates it. */
  revokePairPin(): void { this.pairPin = null; }

  authenticate(sessionToken: string): MobileBridgeDevice | null {
    if (!this.state.enabled || !sessionToken) return null;
    const hash = this.hash(`session:${sessionToken}`);
    const device = this.state.devices.find((entry) => this.secureEqual(entry.tokenHash, hash));
    if (!device) return null;
    const now = Date.now();
    if (now - device.createdAt > 30 * 86400_000 || now - device.lastActiveAt > 7 * 86400_000) { this.revoke(device.id); return null; }
    if (now - device.lastActiveAt >= ACTIVE_WRITE_INTERVAL_MS) {
      device.lastActiveAt = now;
      this.save();
    }
    return this.publicDevice(device);
  }

  devices(): MobileBridgeDevice[] {
    return this.state.devices.map((device) => this.publicDevice(device));
  }

  revoke(id: string): boolean {
    const previous = this.state.devices.length;
    this.state.devices = this.state.devices.filter((device) => device.id !== id);
    if (this.state.devices.length === previous) return false;
    this.save();
    return true;
  }

  setCapability(id: string, capability: unknown): MobileBridgeDevice | null {
    const device = this.state.devices.find((entry) => entry.id === id);
    if (!device) return null;
    device.capability = normalizeCapability(capability);
    this.save();
    return this.publicDevice(device);
  }

  revokeAll(): void {
    this.state.devices = [];
    this.save();
  }

  private publicDevice(device: PairedDeviceRecord): MobileBridgeDevice {
    return {
      id: device.id,
      name: device.name,
      capability: device.capability,
      createdAt: device.createdAt,
      lastActiveAt: device.lastActiveAt,
    };
  }

  private hash(value: string): string {
    return crypto.createHmac('sha256', this.state.secret).update(value).digest('hex');
  }

  private secureEqual(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private pruneTokens(): void {
    const now = Date.now();
    for (const [id, token] of this.pairTokens) if (token.expiresAt < now) this.pairTokens.delete(id);
  }

  private prunePin(): void {
    if (this.pairPin && this.pairPin.expiresAt < Date.now()) this.pairPin = null;
  }

  private save(): void {
    this.store.saveSync(this.state);
  }
}
