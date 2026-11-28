import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import { X509Certificate } from 'crypto';
import { generate } from 'selfsigned';
import { loadProtectedSettings, saveProtectedSettings } from '../security/SecretStore';

/** Tunnel/proxy fakes and APIPA that a phone can never route to. */
function isUnroutable(address: string): boolean {
  if (address.startsWith('169.254.')) return true;
  if (/^198\.1[89]\./.test(address)) return true;
  return false;
}

/**
 * True for IPv6 literals that must stay out: link-local (the phone has no scope
 * id to reach them), ULA (no public route), and the RFC 4941 temporary address.
 *
 * The temporary one matters. Windows publishes it alongside the stable address
 * and rotates it every few hours; it is a /128 while the stable address carries
 * the interface /64, so prefix length is what separates them.
 */
function isUnusableIpv6(address: string, netmask?: string): boolean {
  const ip = address.toLowerCase();
  if (ip.startsWith('fe80:')) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;
  if (netmask && /^ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff$/i.test(netmask)) return true;
  return false;
}

/**
 * Every address the certificate must cover.
 *
 * IPv6 is discovered rather than configured. A residential ISP renumbers its
 * prefix whenever the PPPoE session drops, and Windows derives a different
 * interface identifier for the new prefix, so neither half of a literal stays
 * valid. Baking one into start.bat guaranteed a silent outage on the next
 * renumber: the old address stays on the interface (Deprecated) and keeps
 * answering from the host itself, while the router no longer forwards its
 * prefix — so the desktop looks fine and only the phone fails.
 */
function certificateAddresses(): string[] {
  const out = new Set<string>(['127.0.0.1', '::1']);
  for (const items of Object.values(os.networkInterfaces())) {
    for (const item of items || []) {
      if (!item || item.internal) continue;
      if (item.family === 'IPv4') {
        if (isUnroutable(item.address)) continue;
        out.add(item.address);
        continue;
      }
      if (item.family !== 'IPv6') continue;
      if (isUnusableIpv6(item.address, item.netmask)) continue;
      out.add(item.address.toLowerCase());
    }
  }
  for (const value of String(process.env.IEXA_TLS_EXTRA_IPS || '').split(',')) {
    const ip = value.trim().toLowerCase();
    if (ip) out.add(ip);
  }
  return [...out].sort();
}

const CA_STORE = '.iexa-bridge-ca.json';
const LEAF_STORE = '.iexa-bridge-tls.json';
/** Filename the phone downloads. It now carries the root CA, not the leaf. */
const PUBLIC_CA_FILE = 'iexa-bridge-certificate.crt';
const CA_DAYS = 3650;
const LEAF_DAYS = 90;
const RENEW_BEFORE_MS = 7 * 86400_000;
/** How often the address set is re-checked for a prefix change. */
const ADDRESS_POLL_MS = 30_000;
/** Leaf CN. Deliberately different from the CA's so it never reads as self-signed. */
const LEAF_CN = 'IEXA Bridge Node';

interface CaConfig { caCert?: string; caKey?: string; createdAt?: number }
interface LeafConfig { cert?: string; key?: string; password?: string; expiresAt?: number; addresses?: string[] }

function isCaCert(pem: string | undefined): boolean {
  if (!pem) return false;
  try {
    const cert = new X509Certificate(pem);
    return cert.ca === true;
  } catch {
    return false;
  }
}

function certExpiry(pem: string | undefined): number {
  if (!pem) return 0;
  try {
    return new Date(new X509Certificate(pem).validTo).getTime();
  } catch {
    return 0;
  }
}

/** Common name of the first certificate in a PEM bundle, or '' when unparsable. */
function certSubjectCn(pem: string | undefined): string {
  if (!pem) return '';
  try {
    const match = /CN=([^,\n]+)/.exec(new X509Certificate(pem).subject);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

/**
 * Optional LAN listener. Never expose the desktop HTTP listener on 0.0.0.0.
 *
 * Certificates are split into a long-lived root CA and a short-lived leaf.
 * The phone installs the CA once; a renumber then only re-signs the leaf, which
 * needs no new trust decision. Before this split every prefix change forced a
 * fresh install on the phone, which is exactly why the bridge kept breaking.
 */
export class MobileTlsListener {
  private server: https.Server | null = null;
  private redirect: http.Server | null = null;
  private starting: Promise<number> | null = null;
  private watcher: NodeJS.Timeout | null = null;
  private addresses: string[] = [];
  constructor(private readonly workspace: string, private readonly handler: import('http').RequestListener) {}

  /** Addresses currently covered by the served certificate. */
  currentAddresses(): string[] {
    return [...this.addresses];
  }

  async start(): Promise<number> {
    if (this.server?.listening) return (this.server.address() as { port: number }).port;
    if (this.starting) return this.starting;
    this.starting = this.open();
    try { return await this.starting; } finally { this.starting = null; }
  }

  /** Plain http://<lan-ip>/ must land on https, otherwise a phone typing the bare IP fails. */
  private listenRedirect(tlsPort: number): void {
    if (tlsPort !== 443 || this.redirect) return;
    const server = http.createServer((req, res) => {
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      const location = `https://${host}${req.url || '/'}`;
      res.writeHead(301, { Location: location, 'Cache-Control': 'no-store' });
      res.end();
    });
    server.on('error', () => { this.redirect = null; });
    server.listen(80, '::', () => { this.redirect = server; });
  }

  /**
   * Load or create the root CA.
   *
   * A certificate issued by an earlier version of this file is adopted as the
   * CA when it carries cA:true, so a phone that already trusted that install
   * keeps working instead of demanding another round of manual trust.
   */
  private async ensureCa(): Promise<CaConfig> {
    const caPath = path.join(this.workspace, CA_STORE);
    const stored = loadProtectedSettings<CaConfig>(caPath, () => ({}));
    if (stored.caCert && stored.caKey && certExpiry(stored.caCert) > Date.now() + 30 * 86400_000) {
      return stored;
    }

    const migrated = loadProtectedSettings<LeafConfig>(path.join(this.workspace, LEAF_STORE), () => ({}));
    // The previous version stored the private key in `password`, not `key`.
    // Adopting it keeps a phone that already trusted that install working
    // without a second manual profile install.
    const previousKey = migrated.key || migrated.password;
    if (isCaCert(migrated.cert) && previousKey && certExpiry(migrated.cert) > Date.now() + 30 * 86400_000) {
      const adopted: CaConfig = { caCert: migrated.cert, caKey: previousKey, createdAt: Date.now() };
      saveProtectedSettings(caPath, adopted);
      // Re-publish the same bytes at the download path so the phone imports
      // exactly the anchor it already trusts.
      fs.writeFileSync(path.join(this.workspace, PUBLIC_CA_FILE), migrated.cert!);
      return adopted;
    }

    const created = await generate([
      { name: 'commonName', value: 'IEXA Local Bridge CA' },
      { name: 'organizationName', value: 'IEXA' },
    ], {
      keySize: 2048,
      algorithm: 'sha256',
      notBeforeDate: new Date(Date.now() - 60_000),
      notAfterDate: new Date(Date.now() + CA_DAYS * 86400_000),
      extensions: [
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true, cRLSign: true, critical: true },
      ],
    });
    const ca: CaConfig = { caCert: created.cert, caKey: created.private, createdAt: Date.now() };
    saveProtectedSettings(caPath, ca);
    // The phone imports this once. Kept at the historical filename so a
    // bookmark to the download URL keeps working.
    fs.writeFileSync(path.join(this.workspace, PUBLIC_CA_FILE), created.cert);
    return ca;
  }

  /** Re-sign the leaf whenever the address set drifts or it is close to expiry. */
  private async ensureLeaf(ca: CaConfig, addresses: string[]): Promise<LeafConfig> {
    const leafPath = path.join(this.workspace, LEAF_STORE);
    const stored = loadProtectedSettings<LeafConfig>(leafPath, () => ({}));
    const storedSet = Array.isArray(stored.addresses) ? stored.addresses.map((ip) => String(ip).toLowerCase()) : [];
    const sameSet = storedSet.length === addresses.length && storedSet.every((ip) => addresses.includes(ip));
    const fresh = certExpiry(stored.cert) > Date.now() + RENEW_BEFORE_MS;
    // A certificate carried over from the single-certificate version is a CA
    // (cA:true). Serving that as the leaf would hand the phone a self-signed
    // chain instead of leaf+issuer, so it must be re-signed even when its dates
    // and address set still look valid.
    const isLeaf = Boolean(stored.cert) && !isCaCert(stored.cert);
    // A leaf issued before the CN split carries the same name as the CA and can
    // never verify, so it must be treated as stale rather than reused.
    const hasDistinctCn = certSubjectCn(stored.cert) === LEAF_CN;
    if (stored.cert && stored.key && isLeaf && hasDistinctCn && sameSet && fresh) return stored;

    const signed = await generate([
      // Must differ from the CA's CN. When both read "IEXA Local Bridge" the
      // verifier treats the leaf as self-signed (its issuer string matches its
      // own subject) and every handshake dies with DEPTH_ZERO_SELF_SIGNED_CERT,
      // which is exactly what broke the phone after the CA/leaf split.
      { name: 'commonName', value: LEAF_CN },
      { name: 'organizationName', value: 'IEXA' },
    ], {
      keySize: 2048,
      algorithm: 'sha256',
      notBeforeDate: new Date(Date.now() - 60_000),
      notAfterDate: new Date(Date.now() + LEAF_DAYS * 86400_000),
      ca: { cert: ca.caCert!, key: ca.caKey! },
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            ...addresses.map((ip) => ({ type: 7 as const, ip })),
          ],
        },
      ],
    });
    const leaf: LeafConfig = {
      // The CA is appended so the handshake carries a complete chain. iOS builds
      // the path from the trusted anchor on its own, but older Android versions
      // stop at "unable to get local issuer" unless the issuer is in the
      // Certificate message, so both are sent.
      cert: `${signed.cert.trim()}\n${ca.caCert!.trim()}\n`,
      key: signed.private,
      expiresAt: Date.now() + LEAF_DAYS * 86400_000,
      addresses,
    };
    saveProtectedSettings(leafPath, leaf);
    return leaf;
  }

  /**
   * Re-check the interface addresses and hot-swap the leaf when they change.
   *
   * setSecureContext() replaces the keypair without closing the listener, so an
   * in-flight phone request is not dropped and no restart is needed mid-session.
   */
  private watch(ca: CaConfig): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      const server = this.server;
      if (!server?.listening) return;
      const next = certificateAddresses();
      const unchanged = next.length === this.addresses.length && next.every((ip) => this.addresses.includes(ip));
      if (unchanged) return;
      void this.ensureLeaf(ca, next)
        .then((leaf) => {
          if (!this.server?.listening) return;
          this.server.setSecureContext({ cert: leaf.cert!, key: leaf.key! });
          this.addresses = next;
          console.log('[mobile-bridge] certificate re-issued for', next.join(', '));
        })
        .catch((error) => console.error('[mobile-bridge] re-issue failed:', (error as Error).message));
    }, ADDRESS_POLL_MS);
    this.watcher.unref?.();
  }

  private async open(): Promise<number> {
    const allAddresses = certificateAddresses();
    this.addresses = allAddresses;

    let leaf: LeafConfig;
    if (process.env.IEXA_TLS_CERT && process.env.IEXA_TLS_KEY) {
      leaf = {
        cert: fs.readFileSync(process.env.IEXA_TLS_CERT, 'utf8'),
        key: fs.readFileSync(process.env.IEXA_TLS_KEY, 'utf8'),
      };
    } else {
      const ca = await this.ensureCa();
      leaf = await this.ensureLeaf(ca, allAddresses);
      this.watch(ca);
    }

    const server = https.createServer({ cert: leaf.cert, key: leaf.key, minVersion: 'TLSv1.2' }, this.handler);
    this.server = server;
    server.requestTimeout = 60_000;
    server.headersTimeout = 15_000;
    const port = Number(process.env.IEXA_MOBILE_PORT || 443);
    // '::' is the IPv6 wildcard; on Windows it listens dual-stack, so the
    // existing IPv4 entry (192.168.1.5) keeps working and IPv6 joins it.
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '::', resolve);
    });
    const actual = (server.address() as { port: number }).port;
    this.listenRedirect(actual);
    return actual;
  }

  async stop(): Promise<void> {
    if (this.watcher) { clearInterval(this.watcher); this.watcher = null; }
    if (this.starting) { try { await this.starting; } catch {} }
    const redirect = this.redirect; this.redirect = null;
    if (redirect) { redirect.closeAllConnections(); await new Promise<void>((resolve) => redirect.close(() => resolve())); }
    const server = this.server; this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
