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
exports.saveProtectedSettings = exports.loadProtectedSettings = void 0;
exports.createPlatformSecretCodec = createPlatformSecretCodec;
exports.createProtectedSettingsStore = createProtectedSettingsStore;
/**
 * Settings integration (synchronous, same call shape as JsonStore):
 *   loadProtectedSettings(file, () => defaults); saveProtectedSettings(file, settings);
 * Values named apiKey/password (case/underscore insensitive) are recursive vault
 * references on disk and strings in memory. Never catch protection failures and
 * fall back to plaintext writes. Only explicit settings operations may set secrets.
 *
 * Rollback: the existing .iexa-artifacts/remediation-20260913/baseline is the code
 * baseline, NOT a safe credential backup. Stop all writers and retain config,
 * config.bak and config.vault together on the same OS user/keychain. Restore code
 * only if it understands references; otherwise re-enter credentials explicitly.
 * Do not restore legacy plaintext configs/backups from the baseline into service.
 * Migration replaces live primary/.bak; it does not erase filesystem snapshots,
 * old central artifacts, external backups or SSD history. Handle those explicitly.
 * Multi-process writers must be serialized by the integrating application.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const child_process_1 = require("child_process");
const stripBom_1 = require("../persistence/stripBom");
const MAX_BYTES = 8 * 1024 * 1024;
const secretField = (key) => /^(apikey|password)$/.test(key.replace(/[_-]/g, '').toLowerCase());
const plainObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const failure = () => new Error('Protected settings unavailable or invalid; no plaintext fallback is permitted.');
/** OS-backed protection only: never generates a disk-resident encryption key. */
let platformCodec;
function createPlatformSecretCodec() {
    if (platformCodec)
        return platformCodec;
    try {
        // Node's electron package may be a path string; only the Electron main API qualifies.
        const safe = process.platform === 'win32' ? undefined : require('electron').safeStorage;
        if (safe?.isEncryptionAvailable() && (process.platform !== 'linux' ||
            (typeof safe.getSelectedStorageBackend === 'function' && !['basic_text', 'unknown'].includes(safe.getSelectedStorageBackend())))) {
            return {
                id: 'electron-safeStorage-v1',
                encrypt: value => safe.encryptString(value.toString('base64')),
                decrypt: value => Buffer.from(safe.decryptString(value), 'base64'),
            };
        }
    }
    catch { /* Windows Node server uses CurrentUser DPAPI below. */ }
    if (process.platform !== 'win32')
        throw failure();
    const decrypted = new Map();
    const invoke = (operation, data) => {
        const key = operation === 'Unprotect' && data.length <= 128 * 1024 ? data.toString('base64') : '';
        const cached = key ? decrypted.get(key) : undefined;
        if (cached && cached.expires > Date.now())
            return Buffer.from(cached.data);
        for (const [id, entry] of decrypted)
            if (entry.expires <= Date.now()) {
                entry.data.fill(0);
                decrypted.delete(id);
            }
        const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[System.Security.Cryptography.ProtectedData]::${operation}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
        try {
            const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
            const result = (0, child_process_1.execFileSync)(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
                input: data.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 30_000,
                maxBuffer: MAX_BYTES * 4, stdio: ['pipe', 'pipe', 'pipe'],
            });
            if (!result.trim() || !/^[A-Za-z0-9+/=\r\n]+$/.test(result))
                throw failure();
            const decoded = Buffer.from(result.trim(), 'base64');
            if (key && decoded.length <= 64 * 1024) {
                if (decrypted.size >= 16) {
                    const first = decrypted.keys().next().value;
                    decrypted.get(first).data.fill(0);
                    decrypted.delete(first);
                }
                decrypted.set(key, { data: Buffer.from(decoded), expires: Date.now() + 60_000 });
            }
            return decoded;
        }
        catch {
            throw failure();
        }
    };
    return platformCodec = { id: 'windows-dpapi-current-user-v1', encrypt: b => invoke('Protect', b), decrypt: b => invoke('Unprotect', b) };
}
function read(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES * 4)
        throw failure();
    // PowerShell 5.1's `Set-Content -Encoding utf8` and several editors prefix a
    // BOM; JSON.parse rejects it. Strip only the leading code unit so a BOM that
    // is legitimately inside a JSON string value is preserved.
    return (0, stripBom_1.stripBom)(fs.readFileSync(file, 'utf8'));
}
function atomic(file, value) {
    const data = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(data) > MAX_BYTES * 4)
        throw failure();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile())
        throw failure();
    const temp = `${file}.${(0, crypto_1.randomUUID)()}.tmp`;
    try {
        const fd = fs.openSync(temp, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, data);
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temp, file);
    }
    finally {
        if (fs.existsSync(temp))
            fs.unlinkSync(temp);
    }
}
/** Use a private store instance for injected codecs; no global test-mode bypass. */
function createProtectedSettingsStore(injectedCodec) {
    const operation = (filePath, saving, value, fallback) => {
        if (!filePath)
            throw failure();
        const file = path.resolve(filePath);
        let codec = injectedCodec;
        const getCodec = () => codec || (codec = createPlatformSecretCodec());
        let vault;
        let dirty = false;
        const getVault = () => {
            if (vault)
                return vault;
            if (fs.existsSync(`${file}.vault`)) {
                try {
                    const envelope = JSON.parse(read(`${file}.vault`));
                    if (envelope.version !== 1 || envelope.codec !== getCodec().id || typeof envelope.data !== 'string')
                        throw failure();
                    vault = JSON.parse(getCodec().decrypt(Buffer.from(envelope.data, 'base64')).toString('utf8'));
                    if (!vault || vault.version !== 1 || typeof vault.id !== 'string' || !plainObject(vault.entries))
                        throw failure();
                }
                catch {
                    throw failure();
                }
            }
            else {
                getCodec(); // Reject unsupported environments before any filesystem mutation.
                vault = { version: 1, id: (0, crypto_1.randomUUID)(), entries: Object.create(null) };
            }
            return vault;
        };
        let nodes = 0;
        const visit = (input, scope = '', hydrate = false, depth = 0, previous) => {
            if (++nodes > 200_000 || depth > 64)
                throw failure();
            if (Array.isArray(input))
                return input.map((v, i) => visit(v, `${scope}/${i}`, hydrate, depth + 1, previous?.[i]));
            if (plainObject(input)) {
                const out = {};
                for (const [key, item] of Object.entries(input)) {
                    if (['__proto__', 'constructor', 'prototype', '$secretRef'].includes(key))
                        throw failure();
                    const fieldScope = `${scope}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
                    if (!secretField(key)) {
                        out[key] = visit(item, fieldScope, hydrate, depth + 1, previous?.[key]);
                        continue;
                    }
                    if (item === '' || item === null || item === undefined) {
                        out[key] = item;
                        continue;
                    }
                    const v = getVault();
                    if (plainObject(item) && Object.keys(item).length === 1 && typeof item.$secretRef === 'string') {
                        const prefix = `${v.id}:`;
                        const id = item.$secretRef.startsWith(prefix) ? item.$secretRef.slice(prefix.length) : '';
                        const entry = Object.hasOwn(v.entries, id) ? v.entries[id] : undefined;
                        if (!entry || entry.scope !== fieldScope || typeof entry.value !== 'string')
                            throw failure();
                        out[key] = hydrate ? entry.value : { $secretRef: item.$secretRef };
                    }
                    else {
                        if (typeof item !== 'string' || Buffer.byteLength(item) > 64 * 1024)
                            throw failure();
                        if (hydrate) {
                            out[key] = item;
                            continue;
                        }
                        const oldRef = previous?.[key]?.$secretRef;
                        const oldId = typeof oldRef === 'string' && oldRef.startsWith(`${v.id}:`) ? oldRef.slice(v.id.length + 1) : '';
                        const old = Object.hasOwn(v.entries, oldId) ? v.entries[oldId] : undefined;
                        const id = old?.scope === fieldScope && old.value === item ? oldId : (0, crypto_1.randomUUID)();
                        if (id !== oldId) {
                            v.entries[id] = { scope: fieldScope, value: item };
                            dirty = true;
                        }
                        out[key] = { $secretRef: `${v.id}:${id}` };
                    }
                }
                return out;
            }
            if (input === null || ['string', 'boolean', 'undefined'].includes(typeof input) || (typeof input === 'number' && Number.isFinite(input)))
                return input;
            throw failure();
        };
        const parse = (name) => {
            if (!fs.existsSync(name))
                return { exists: false, valid: false };
            const content = read(name);
            try {
                const parsed = JSON.parse(content);
                return { exists: true, valid: plainObject(parsed), value: parsed };
            }
            catch {
                return { exists: true, valid: false };
            }
        };
        const primary = parse(file), backup = parse(`${file}.bak`);
        if (!primary.valid && !backup.valid && (primary.exists || backup.exists) && !saving)
            throw failure();
        // Protect both generations before replacing either one; never copy plaintext to .bak.
        const protectedPrimary = primary.valid ? visit(primary.value) : undefined;
        const protectedBackup = backup.valid ? visit(backup.value) : undefined;
        let selected = protectedPrimary ?? protectedBackup;
        if (saving) {
            if (!plainObject(value))
                throw failure();
            selected = visit(value, '', false, 0, selected);
        }
        if (selected === undefined)
            return typeof fallback === 'function' ? fallback() : fallback;
        if (dirty) {
            const provider = getCodec();
            const ciphertext = provider.encrypt(Buffer.from(JSON.stringify(getVault())));
            if (!Buffer.isBuffer(ciphertext) || !ciphertext.length)
                throw failure();
            atomic(`${file}.vault`, { version: 1, codec: provider.id, data: ciphertext.toString('base64') });
        }
        const nextBackup = saving ? (protectedPrimary ?? protectedBackup ?? selected) : (protectedBackup ?? selected);
        if ((saving || backup.exists) && (!backup.valid || JSON.stringify(backup.value) !== JSON.stringify(nextBackup)))
            atomic(`${file}.bak`, nextBackup);
        if (saving || !primary.valid || JSON.stringify(primary.value) !== JSON.stringify(selected))
            atomic(file, selected);
        nodes = 0;
        return saving ? undefined : visit(selected, '', true);
    };
    return {
        loadProtectedSettings: (file, fallback) => operation(file, false, undefined, fallback),
        saveProtectedSettings: (file, obj) => operation(file, true, obj),
    };
}
const defaultStore = createProtectedSettingsStore();
exports.loadProtectedSettings = defaultStore.loadProtectedSettings;
exports.saveProtectedSettings = defaultStore.saveProtectedSettings;
//# sourceMappingURL=SecretStore.js.map