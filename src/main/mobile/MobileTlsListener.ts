import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as os from 'os';
import { generate } from 'selfsigned';
import { loadProtectedSettings, saveProtectedSettings } from '../security/SecretStore';

/** Optional LAN listener. Never expose the desktop HTTP listener on 0.0.0.0. */
export class MobileTlsListener {
  private server: https.Server | null = null;
  private starting: Promise<number> | null = null;
  constructor(private readonly workspace: string, private readonly handler: import('http').RequestListener) {}
  async start(): Promise<number> {
    if (this.server?.listening) return (this.server.address() as { port: number }).port;
    if (this.starting) return this.starting;
    this.starting = this.open();
    try { return await this.starting; } finally { this.starting = null; }
  }
  private async open(): Promise<number> {
    const configPath = path.join(this.workspace, '.iexa-bridge-tls.json');
    const addresses = ['127.0.0.1'];
    for (const items of Object.values(os.networkInterfaces())) for (const item of items || []) if (item.family === 'IPv4' && !item.internal) addresses.push(item.address);
    addresses.sort();
    let config = loadProtectedSettings<{ cert?: string; password?: string; expiresAt?: number; addresses?: string[] }>(configPath, () => ({}));
    if (process.env.IEXA_TLS_CERT && process.env.IEXA_TLS_KEY) {
      config = { cert: fs.readFileSync(process.env.IEXA_TLS_CERT, 'utf8'), password: fs.readFileSync(process.env.IEXA_TLS_KEY, 'utf8') };
    } else if (!config.cert || !config.password || !config.expiresAt || config.expiresAt < Date.now() + 86400_000 || JSON.stringify(config.addresses) !== JSON.stringify(addresses)) {
      const generated = await generate([{ name: 'commonName', value: 'IEXA Local Bridge' }], {
        keySize: 2048, algorithm: 'sha256', notBeforeDate: new Date(Date.now() - 60_000), notAfterDate: new Date(Date.now() + 90 * 86400_000),
        extensions: [{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true }, { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...addresses.map(ip => ({ type: 7 as const, ip }))] }],
      });
      config = { cert: generated.cert, password: generated.private, expiresAt: Date.now() + 89 * 86400_000, addresses };
      saveProtectedSettings(configPath, config);
      // Public certificate can be imported on paired devices; private key stays in the protected vault.
      fs.writeFileSync(path.join(this.workspace, 'iexa-bridge-certificate.crt'), generated.cert);
    }
    const server = https.createServer({ cert: config.cert, key: config.password, minVersion: 'TLSv1.2' }, this.handler);
    this.server = server; server.requestTimeout = 60_000; server.headersTimeout = 15_000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.IEXA_MOBILE_PORT || 0), '0.0.0.0', resolve); });
    return (server.address() as { port: number }).port;
  }
  async stop(): Promise<void> { if (this.starting) { try { await this.starting; } catch {} } const server = this.server; this.server = null; if (!server) return; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
