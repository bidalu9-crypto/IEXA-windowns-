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

export interface MobileBridgeDevice {
  id: string;
  name: string;
  capability: MobileCapability;
  createdAt: number;
  lastActiveAt: number;
}

const PAIR_TOKEN_TTL_MS = 5 * 60 * 1000;
const ACTIVE_WRITE_INTERVAL_MS = 60 * 1000;

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

function networkAddresses(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      addresses.add(entry.address);
    }
  }
  return [...addresses];
}

export class MobileBridgeManager {
  private readonly store: JsonStore<MobileBridgeStore>;
  private state: MobileBridgeStore;
  private pairTokens = new Map<string, PairTokenRecord>();
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
    if (!this.state.enabled) this.pairTokens.clear();
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
    const host = address || networkAddresses()[0];
    if (!host || !this.port) throw new Error('没有检测到可用的局域网地址。');
    return { token, expiresAt, url: `http://${host}:${this.port}/?pair=${encodeURIComponent(token)}` };
  }

  pair(token: string, name: string): { device: MobileBridgeDevice; sessionToken: string } | null {
    if (!this.state.enabled || !token) return null;
    this.pruneTokens();
    const id = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
    const record = this.pairTokens.get(id);
    if (!record || record.expiresAt < Date.now() || !this.secureEqual(record.hash, this.hash(`pair:${token}`))) return null;
    this.pairTokens.delete(id);

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

  authenticate(sessionToken: string): MobileBridgeDevice | null {
    if (!this.state.enabled || !sessionToken) return null;
    const hash = this.hash(`session:${sessionToken}`);
    const device = this.state.devices.find((entry) => this.secureEqual(entry.tokenHash, hash));
    if (!device) return null;
    const now = Date.now();
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

  private save(): void {
    this.store.saveSync(this.state);
  }
}
