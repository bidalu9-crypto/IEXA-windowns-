"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProviderError = void 0;
const stream_utils_1 = require("./stream-utils");
const IexaError_1 = require("../errors/IexaError");
const TRANSIENT_CODE = /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)|overloaded_error|server_error|internal_server_error|internal_error|bad_gateway|gateway_timeout|service_unavailable|unavailable|resource_exhausted|rate_limit_exceeded|rate_limit_error|upstream_error|upstream_unavailable|no_available_channel)$/i;
const PERMANENT_CODE = /^(?:invalid_api_key|authentication_error|permission_denied|permission_error|invalid_request_error|invalid_argument|not_found|model_not_found|insufficient_quota|quota_exceeded|billing_hard_limit_reached|account_deactivated|content_policy_violation)$/i;
const TRANSIENT_MESSAGE = /timeout|timed out|network|socket|econn|connection reset|temporar|overload|stream idle|no response body|premature|fetch failed|\bterminated\b|bad gateway|gateway (?:error|unavailable)|upstream (?:error|unavailable|connect|request failed)|service unavailable|no (?:available|healthy) (?:channels?|upstreams?)|无可用渠道|渠道.*不可用/i;
function statusNumber(value) {
    if (typeof value !== 'number' && typeof value !== 'string')
        return undefined;
    const n = Number(value);
    return Number.isInteger(n) && n >= 400 && n <= 599 ? n : undefined;
}
/** Inspect causes/aggregate failures without serializing credentials or following cycles. */
function details(error) {
    const result = { codes: [], messages: [], aborted: false };
    const seen = new Set();
    const queue = [error];
    for (let i = 0; i < queue.length && i < 32; i++) {
        const item = queue[i];
        if (!item || seen.has(item))
            continue;
        seen.add(item);
        if (typeof item === 'string') {
            result.messages.push(item);
            continue;
        }
        if (typeof item !== 'object')
            continue;
        const value = item;
        result.aborted ||= (0, stream_utils_1.isAbortError)(value);
        result.status ??= statusNumber(value.status) ?? statusNumber(value.statusCode) ?? statusNumber(value.httpStatus) ?? statusNumber(value.response?.status) ?? statusNumber(value.code);
        for (const code of [value.code, value.type, value.status])
            if (typeof code === 'string')
                result.codes.push(code);
        if (typeof value.message === 'string')
            result.messages.push(value.message);
        for (const cause of [value.error, value.cause, value.response?.error])
            if (cause)
                queue.push(cause);
        if (Array.isArray(value.errors))
            queue.push(...value.errors.slice(0, 16));
    }
    // Only status-labelled numbers are HTTP statuses, never token counts/ports/request IDs.
    if (!result.status)
        for (const message of result.messages) {
            result.status = statusNumber(message.match(/(?:\bHTTP(?:[ /]\d(?:\.\d)?)?[_ :]+|\b(?:API error|status(?: code)?|statusCode)[\s:=]+)([45]\d{2})\b/i)?.[1]);
            if (result.status)
                break;
        }
    return result;
}
class ProviderError extends IexaError_1.IexaError {
    status;
    constructor(code, userMessage, retryable, status, cause) {
        super(code, 'PROVIDER', userMessage, retryable, cause);
        this.status = status;
    }
    static from(error) {
        if (error instanceof ProviderError)
            return error;
        const info = details(error);
        const message = info.messages[0] || 'Provider request failed';
        if (info.aborted)
            return new ProviderError('PROVIDER_ABORTED', message, false, undefined, error);
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
    static http(status, body, label = 'Provider') {
        let payload;
        try {
            payload = JSON.parse(body);
        }
        catch {
            payload = undefined;
        }
        // The body is a JSON envelope, not a sentence: showing it verbatim buries the
        // one line the user needs under `type`/`param`/`code`/`request id` noise.
        // Keep the readable part as the message and the raw body as the cause.
        return ProviderError.from({ status, message: ProviderError.describe(status, body, payload, label), error: payload });
    }
    /** A short, human sentence for a failed HTTP response. */
    static describe(status, body, payload, label) {
        const text = (value) => {
            if (typeof value !== 'string')
                return undefined;
            const trimmed = value.replace(/\s+/g, ' ').trim();
            return trimmed || undefined;
        };
        const fromEnvelope = text(payload?.error?.message)
            || text(payload?.message)
            || text(payload?.error)
            || text(payload?.error_msg)
            || text(payload?.detail);
        if (fromEnvelope)
            return fromEnvelope.slice(0, 300);
        const fallback = text(body);
        if (fallback && !/^[[{]/.test(fallback))
            return `${label} API error ${status}: ${fallback.slice(0, 300)}`;
        return `${label} API error ${status}${fallback ? '：' + fallback.slice(0, 300) : ''}`;
    }
    /** A successful HTTP transport can still carry a failed provider response. */
    static throwIfErrorFrame(frame, eventType = '') {
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
exports.ProviderError = ProviderError;
//# sourceMappingURL=ProviderError.js.map