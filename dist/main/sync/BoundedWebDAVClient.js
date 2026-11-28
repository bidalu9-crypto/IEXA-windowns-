"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.boundWebDAVClient = boundWebDAVClient;
/** webdav 5 uses fetch; its legacy maxContentLength option is not enforced.
 * Use its authenticated customRequest + exported DAV parser, but cap bodies BEFORE
 * XML/JSON parsing. No global fetch patches or changes to another client's state.
 */
const stream_1 = require("stream");
const SyncDataProtection_1 = require("./SyncDataProtection");
const MAX_DAV_BYTES = 4 * 1024 * 1024;
const failure = () => new Error('Invalid or oversized WebDAV response.');
async function* chunks(response, limit) {
    if (!response?.body || typeof response.body[Symbol.asyncIterator] !== 'function')
        throw failure();
    const declared = response.headers?.get?.('content-length');
    if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
        response.body.destroy?.();
        throw failure();
    }
    let size = 0;
    try {
        for await (const chunk of response.body) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > limit)
                throw failure();
            yield bytes;
        }
    }
    finally {
        response.body.destroy?.();
    }
}
function boundWebDAVClient(client, dav, endpoint) {
    const base = new URL(endpoint);
    const requestPath = (remote) => `${base.pathname.replace(/\/$/, '')}/${remote.replace(/^\//, '')}`;
    const propfind = async (remote, depth, signal) => {
        const controller = new AbortController();
        const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
        try {
            const response = await client.customRequest(remote, {
                method: 'PROPFIND', headers: { Depth: String(depth), Accept: 'application/xml', 'Content-Type': 'application/xml; charset=utf-8' },
                data: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getlastmodified/><d:getcontentlength/><d:getetag/><d:getcontenttype/></d:prop></d:propfind>',
                signal: combined,
            });
            const buffers = [];
            for await (const chunk of chunks(response, MAX_DAV_BYTES))
                buffers.push(chunk);
            const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers));
            if (!text || /<!DOCTYPE|<!ENTITY/i.test(text))
                throw failure();
            return await dav.parseXML(text, { attributeNamePrefix: '@', attributeParsers: [], tagParsers: [], entityDecoder: { limit: { maxTotalExpansions: 10_000, maxExpandedLength: MAX_DAV_BYTES } } });
        }
        finally {
            controller.abort();
        }
    };
    const stat = async (remote, options = {}) => {
        const parsed = await propfind(remote, 0, options.signal);
        const items = parsed?.multistatus?.response;
        if (!Array.isArray(items) || items.length !== 1)
            throw failure();
        return dav.parseStat(parsed, remote, false);
    };
    const getDirectoryContents = (async (remote, options = {}) => {
        if (options.deep || options.details)
            throw new Error('Only bounded shallow WebDAV listings are supported.');
        const parsed = await propfind(remote, 1, options.signal);
        const items = parsed?.multistatus?.response;
        if (!Array.isArray(items) || items.length > 10_001)
            throw failure();
        const expected = decodeURIComponent(requestPath(remote)).replace(/\/$/, '');
        const files = [];
        for (const item of items) {
            if (typeof item?.href !== 'string' || !item.propstat?.prop)
                throw failure();
            const href = new URL(item.href, new URL(`${requestPath(remote).replace(/\/$/, '')}/`, base));
            if (href.origin !== base.origin || href.search || href.hash)
                throw failure();
            const decoded = decodeURIComponent(href.pathname).replace(/\/$/, '');
            if (decoded === expected)
                continue; // Standard PROPFIND includes the directory itself.
            if (!decoded.startsWith(`${expected}/`))
                throw failure();
            const name = decoded.slice(expected.length + 1);
            (0, SyncDataProtection_1.assertRemoteBasename)(name); // Validate relative href, not a lossy basename().
            files.push(dav.prepareFileFromProps(item.propstat.prop, `${remote.replace(/\/$/, '')}/${name}`, false));
        }
        return files;
    });
    const createReadStream = (remote, options = {}) => {
        const controller = new AbortController();
        const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]);
        return stream_1.Readable.from((async function* () {
            try {
                const response = await client.customRequest(remote, { method: 'GET', signal: combined });
                yield* chunks(response, SyncDataProtection_1.MAX_SYNC_BYTES);
            }
            finally {
                controller.abort();
            }
        })());
    };
    return { ...client, stat, getDirectoryContents, createReadStream,
        exists: async (remote) => {
            try {
                await stat(remote);
                return true;
            }
            catch (error) {
                if (error?.status === 404 || error?.response?.status === 404)
                    return false;
                throw error;
            }
        },
    };
}
//# sourceMappingURL=BoundedWebDAVClient.js.map