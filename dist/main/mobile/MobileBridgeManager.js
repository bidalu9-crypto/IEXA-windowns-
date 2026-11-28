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
exports.MobileBridgeManager = void 0;
const crypto = __importStar(require("crypto"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const JsonStore_1 = require("../persistence/JsonStore");
const PAIR_TOKEN_TTL_MS = 5 * 60 * 1000;
const ACTIVE_WRITE_INTERVAL_MS = 60 * 1000;
/** Four digits is 10k combinations, so a wrong guess spends a try. */
const PAIR_PIN_ATTEMPTS = 5;
const PAIR_PIN_LENGTH = 4;
function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}
function normalizeCapability(value) {
    return value === 'chat' || value === 'files' || value === 'full' ? value : 'chat';
}
function normalizeStore(value) {
    const source = value && typeof value === 'object' ? value : {};
    const devices = Array.isArray(source.devices) ? source.devices : [];
    return {
        enabled: source.enabled === true,
        defaultCapability: normalizeCapability(source.defaultCapability),
        secret: typeof source.secret === 'string' && source.secret.length >= 32 ? source.secret : randomToken(48),
        devices: devices.flatMap((entry) => {
            if (!entry || typeof entry !== 'object')
                return [];
            const item = entry;
            if (typeof item.id !== 'string' || typeof item.tokenHash !== 'string')
                return [];
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
function isUnroutableFromLan(address) {
    if (address.startsWith('169.254.'))
        return true;
    if (/^198\.1[89]\./.test(address))
        return true;
    return false;
}
/**
 * Mirror of the listener's IPv6 filter. A residential prefix renumbers whenever
 * PPPoE reconnects, so pairing codes have to follow whatever address the router
 * is currently advertising instead of a literal baked into start.bat. The
 * rotating RFC 4941 temporary address is still excluded (it is the /128); a
 * code pointing at it would expire within hours.
 */
function isUnusableIpv6(address, netmask) {
    const ip = address.toLowerCase();
    if (ip.startsWith('fe80:'))
        return true;
    if (/^f[cd][0-9a-f]{2}:/.test(ip))
        return true;
    if (netmask && /^ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff$/i.test(netmask))
        return true;
    return false;
}
function networkAddresses() {
    const addresses = new Set();
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries || []) {
            if (!entry || entry.internal)
                continue;
            if (entry.family === 'IPv4') {
                if (isUnroutableFromLan(entry.address))
                    continue;
                addresses.add(entry.address);
                continue;
            }
            if (entry.family !== 'IPv6')
                continue;
            if (isUnusableIpv6(entry.address, entry.netmask))
                continue;
            addresses.add(entry.address.toLowerCase());
        }
    }
    return [...addresses];
}
/** Real LAN addresses first so pairing codes never default to a tunnel IP. */
function preferredAddress() {
    const all = networkAddresses();
    return all.find((address) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address))
        || all.find((address) => address.includes(':'))
        || all[0];
}
class MobileBridgeManager {
    store;
    state;
    pairTokens = new Map();
    pairPin = null;
    port = 0;
    constructor(workspaceDir) {
        this.store = new JsonStore_1.JsonStore(path.join(workspaceDir, '.iexa-mobile-bridge.json'), () => normalizeStore({}));
        this.state = normalizeStore(this.store.loadSync());
        this.save();
    }
    setPort(port) {
        this.port = port;
    }
    isEnabled() {
        return this.state.enabled;
    }
    status() {
        return {
            enabled: this.state.enabled,
            defaultCapability: this.state.defaultCapability,
            addresses: networkAddresses(),
            port: this.port,
            devices: this.devices(),
        };
    }
    configure(input) {
        if (typeof input.enabled === 'boolean')
            this.state.enabled = input.enabled;
        if (input.defaultCapability !== undefined)
            this.state.defaultCapability = normalizeCapability(input.defaultCapability);
        if (!this.state.enabled) {
            this.pairTokens.clear();
            this.pairPin = null;
        }
        this.save();
        return this.status();
    }
    createPairToken(address) {
        if (!this.state.enabled)
            throw new Error('请先开启手机桥接。');
        this.pruneTokens();
        const token = randomToken(24);
        const id = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
        const expiresAt = Date.now() + PAIR_TOKEN_TTL_MS;
        this.pairTokens.set(id, { hash: this.hash(`pair:${token}`), expiresAt });
        const host = String(address || preferredAddress() || '').replace(/^\[|\]$/g, '');
        if (host && ![...networkAddresses(), '127.0.0.1', 'localhost', '::1'].includes(host))
            throw new Error('配对地址不属于本机。');
        if (!host || !this.port)
            throw new Error('没有检测到可用的局域网地址。');
        // An IPv6 literal must be bracketed in a URL (RFC 3986); 443 is implicit.
        const authority = host.includes(':') ? `[${host}]` : host;
        const portPart = this.port === 443 ? '' : `:${this.port}`;
        return { token, expiresAt, url: `https://${authority}${portPart}/#pair=${encodeURIComponent(token)}` };
    }
    /** Four digits, uniform, no leading-zero bias. Replaces any previous code. */
    createPairPin() {
        if (!this.state.enabled)
            throw new Error('请先开启手机桥接。');
        const expiresAt = Date.now() + PAIR_TOKEN_TTL_MS;
        let code = '';
        // crypto.randomInt is rejection-sampled, so every 0000-9999 value is equally
        // likely; Math.random() would leak a modulo bias.
        for (let i = 0; i < PAIR_PIN_LENGTH; i += 1)
            code += String(crypto.randomInt(0, 10));
        this.pairPin = { hash: this.hash(`pin:${code}`), expiresAt, attempts: 0 };
        return { code, expiresAt, ttlMs: PAIR_TOKEN_TTL_MS };
    }
    /** Whether a usable code exists, without ever revealing it. */
    pairPinState() {
        this.prunePin();
        return { active: Boolean(this.pairPin), expiresAt: this.pairPin?.expiresAt || 0 };
    }
    /** Null on success, otherwise the reason so the phone can show it. */
    pairWithPin(code, name) {
        if (!this.state.enabled)
            return { error: '电脑端的手机桥接当前已关闭。' };
        this.prunePin();
        const pin = this.pairPin;
        if (!pin)
            return { error: '验证码已失效，请在电脑端重新生成。' };
        const digits = String(code || '').replace(/\D/g, '').slice(0, PAIR_PIN_LENGTH);
        if (digits.length !== PAIR_PIN_LENGTH)
            return { error: '请输入完整的四位数字验证码。' };
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
    pair(token, name) {
        if (!this.state.enabled || !token)
            return null;
        this.pruneTokens();
        const id = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
        const record = this.pairTokens.get(id);
        if (!record || record.expiresAt < Date.now() || !this.secureEqual(record.hash, this.hash(`pair:${token}`)))
            return null;
        this.pairTokens.delete(id);
        return this.registerDevice(name);
    }
    /** Shared tail of both pairing paths: mint a session and store the device. */
    registerDevice(name) {
        const now = Date.now();
        const sessionToken = randomToken(36);
        const device = {
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
    revokePairPin() { this.pairPin = null; }
    authenticate(sessionToken) {
        if (!this.state.enabled || !sessionToken)
            return null;
        const hash = this.hash(`session:${sessionToken}`);
        const device = this.state.devices.find((entry) => this.secureEqual(entry.tokenHash, hash));
        if (!device)
            return null;
        const now = Date.now();
        if (now - device.createdAt > 30 * 86400_000 || now - device.lastActiveAt > 7 * 86400_000) {
            this.revoke(device.id);
            return null;
        }
        if (now - device.lastActiveAt >= ACTIVE_WRITE_INTERVAL_MS) {
            device.lastActiveAt = now;
            this.save();
        }
        return this.publicDevice(device);
    }
    devices() {
        return this.state.devices.map((device) => this.publicDevice(device));
    }
    revoke(id) {
        const previous = this.state.devices.length;
        this.state.devices = this.state.devices.filter((device) => device.id !== id);
        if (this.state.devices.length === previous)
            return false;
        this.save();
        return true;
    }
    setCapability(id, capability) {
        const device = this.state.devices.find((entry) => entry.id === id);
        if (!device)
            return null;
        device.capability = normalizeCapability(capability);
        this.save();
        return this.publicDevice(device);
    }
    revokeAll() {
        this.state.devices = [];
        this.save();
    }
    publicDevice(device) {
        return {
            id: device.id,
            name: device.name,
            capability: device.capability,
            createdAt: device.createdAt,
            lastActiveAt: device.lastActiveAt,
        };
    }
    hash(value) {
        return crypto.createHmac('sha256', this.state.secret).update(value).digest('hex');
    }
    secureEqual(left, right) {
        const a = Buffer.from(left);
        const b = Buffer.from(right);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    pruneTokens() {
        const now = Date.now();
        for (const [id, token] of this.pairTokens)
            if (token.expiresAt < now)
                this.pairTokens.delete(id);
    }
    prunePin() {
        if (this.pairPin && this.pairPin.expiresAt < Date.now())
            this.pairPin = null;
    }
    save() {
        this.store.saveSync(this.state);
    }
}
exports.MobileBridgeManager = MobileBridgeManager;
//# sourceMappingURL=MobileBridgeManager.js.map