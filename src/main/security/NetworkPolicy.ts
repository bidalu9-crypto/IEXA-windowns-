import { lookup } from 'dns/promises';
import * as net from 'net';
import { IexaError } from '../errors/IexaError';

function privateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

export class NetworkPolicy {
  async assertAllowed(input: string): Promise<URL> {
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); }
    catch { throw new IexaError('URL_INVALID', 'NETWORK', 'URL 格式无效。'); }
    if (url.protocol !== 'https:') throw new IexaError('URL_PROTOCOL', 'NETWORK', '仅允许 HTTPS 网络请求。');
    if (url.username || url.password) throw new IexaError('URL_CREDENTIALS', 'NETWORK', 'URL 不允许包含凭据。');
    const host = url.hostname.replace(/[\[\]]/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || privateIp(host)) {
      throw new IexaError('SSRF_PRIVATE', 'SECURITY', '不允许访问本机或私有网络地址。');
    }
    try {
      const records = await lookup(host, { all: true });
      if (!records.length || records.some((record) => privateIp(record.address))) {
        throw new IexaError('SSRF_PRIVATE', 'SECURITY', '目标解析到受限制的网络地址。');
      }
    } catch (error) {
      if (error instanceof IexaError) throw error;
      throw new IexaError('DNS_FAILED', 'NETWORK', '无法验证目标网络地址。', true, error);
    }
    return url;
  }
}
