import { isAbortError } from './stream-utils';
import { IexaError } from '../errors/IexaError';

const TRANSIENT_CODE = /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)|overloaded_error|server_error|internal_server_error|internal_error|bad_gateway|gateway_timeout|service_unavailable|unavailable|resource_exhausted|rate_limit_exceeded|rate_limit_error|upstream_error|upstream_unavailable|no_available_channel)$/i;
const PERMANENT_CODE = /^(?:invalid_api_key|authentication_error|permission_denied|permission_error|invalid_request_error|invalid_argument|not_found|model_not_found|insufficient_quota|quota_exceeded|billing_hard_limit_reached|account_deactivated|content_policy_violation)$/i;
const TRANSIENT_MESSAGE = /timeout|timed out|network|socket|econn|connection reset|temporar|overload|stream idle|no response body|premature|fetch failed|\bterminated\b|bad gateway|gateway (?:error|unavailable)|upstream (?:error|unavailable|connect|request failed)|service unavailable|no (?:available|healthy) (?:channels?|upstreams?)|无可用渠道|渠道.*不可用/i;

function statusNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : undefined;
}

/** Inspect causes/aggregate failures without serializing credentials or following cycles. */
function details(error: unknown): { status?: number; codes: string[]; messages: string[]; aborted: boolean } {
  const result: { status?: number; codes: string[]; messages: string[]; aborted: boolean } = { codes: [], messages: [], aborted: false };
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  for (let i = 0; i < queue.length && i < 32; i++) {
    const item = queue[i];
    if (!item || seen.has(item)) continue;
    seen.add(item);
    if (typeof item === 'string') { result.messages.push(item); continue; }
    if (typeof item !== 'object') continue;
    const value = item as Record<string, any>;
    result.aborted ||= isAbortError(value);
    result.status ??= statusNumber(value.status) ?? statusNumber(value.statusCode) ?? statusNumber(value.httpStatus) ?? statusNumber(value.response?.status) ?? statusNumber(value.code);
    for (const code of [value.code, value.type, value.status]) if (typeof code === 'string') result.codes.push(code);
    if (typeof value.message === 'string') result.messages.push(value.message);
    for (const cause of [value.error, value.cause, value.response?.error]) if (cause) queue.push(cause);
    if (Array.isArray(value.errors)) queue.push(...value.errors.slice(0, 16));
  }
  // Only status-labelled numbers are HTTP statuses, never token counts/ports/request IDs.
  if (!result.status) for (const message of result.messages) {
    result.status = statusNumber(message.match(/(?:\bHTTP(?:[ /]\d(?:\.\d)?)?[_ :]+|\b(?:API error|status(?: code)?|statusCode)[\s:=]+)([45]\d{2})\b/i)?.[1]);
    if (result.status) break;
  }
  return result;
}

export class ProviderError extends IexaError {
  constructor(code: string, userMessage: string, retryable: boolean, public readonly status?: number, cause?: unknown) {
    super(code, 'PROVIDER', userMessage, retryable, cause);
  }

  static from(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    const info = details(error);
    const message = info.messages[0] || 'Provider request failed';
    if (info.aborted) return new ProviderError('PROVIDER_ABORTED', message, false, undefined, error);
    const { status } = info;
    const retryable = !info.codes.some(code => PERMANENT_CODE.test(code)) && (status !== undefined
      ? status === 408 || status === 425 || status === 429 || status >= 500
      : info.codes.some(code => TRANSIENT_CODE.test(code)) || info.messages.some(text => TRANSIENT_MESSAGE.test(text)));
    const streamTerminated = /^terminated$/i.test(message.trim()) || /response body.*terminated/i.test(message);
    const userMessage = streamTerminated
      ? '模型的流式连接被服务端或网络代理中途断开，自动重试后仍未恢复。请检查模型端点或网络连接后重试。'
      : message;
    return new ProviderError(status ? `HTTP_${status}` : streamTerminated ? 'STREAM_TERMINATED' : 'PROVIDER_FAILED', userMessage, retryable, status, error);
  }

  static http(status: number, body: string, label = 'Provider'): ProviderError {
    let payload: unknown;
    try { payload = JSON.parse(body); } catch { payload = undefined; }
    return ProviderError.from({ status, message: `${label} API error ${status}: ${body}`, error: payload });
  }

  /** A successful HTTP transport can still carry a failed provider response. */
  static throwIfErrorFrame(frame: any, eventType = ''): void {
    const type = frame?.type || eventType;
    if (frame?.error || frame?.response?.error || type === 'error' || type === 'response.failed') {
      const payload = frame?.error || frame?.response?.error || frame;
      throw ProviderError.from({
        status: frame?.status_code ?? frame?.status ?? frame?.response?.status_code,
        error: payload,
        message: typeof payload === 'string' ? payload : payload?.message || 'Provider stream failed',
      });
    }
  }
}
