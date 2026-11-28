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
exports.DiagnosticDecoder = void 0;
exports.decodeDiagnostic = decodeDiagnostic;
exports.readDiagnosticResponse = readDiagnosticResponse;
const iconv = __importStar(require("iconv-lite"));
/** Decode raw diagnostic bytes once. Valid UTF-8 (including literal U+FFFD)
 * must not be reinterpreted as GBK. A declared encoding takes precedence. */
function decodeDiagnostic(bytes, encoding) {
    if (!bytes.length)
        return '';
    if (encoding && iconv.encodingExists(encoding))
        return iconv.decode(bytes, encoding);
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
        return iconv.decode(bytes.subarray(2), 'utf16le');
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
        return iconv.decode(bytes.subarray(2), 'utf16be');
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        return iconv.decode(bytes, 'gb18030');
    }
}
/** Line buffering keeps GBK/UTF-8 characters intact across arbitrary pipe
 * chunks. The cap bounds unbroken diagnostic lines from a noisy process. */
class DiagnosticDecoder {
    pending = Buffer.alloc(0);
    write(chunk) {
        this.pending = Buffer.concat([this.pending, chunk]);
        const end = this.pending.lastIndexOf(10);
        if (end >= 0) {
            const text = decodeDiagnostic(this.pending.subarray(0, end + 1));
            this.pending = this.pending.subarray(end + 1);
            return text;
        }
        if (this.pending.length > 65536) {
            // Prefer a prefix with complete UTF-8/GB18030 characters. Keep at most
            // four trailing bytes so the next chunk can finish the last character.
            for (let keep = 0; keep <= 4; keep++) {
                const bytes = this.pending.subarray(0, this.pending.length - keep);
                const text = decodeDiagnostic(bytes);
                if (!text.endsWith('\uFFFD')) {
                    this.pending = this.pending.subarray(bytes.length);
                    return text;
                }
            }
            // Invalid bytes are still diagnostics: emit a bounded replacement rather
            // than retaining an ever-growing undecodable line indefinitely.
            const prefix = this.pending.subarray(0, this.pending.length - 4);
            this.pending = this.pending.subarray(prefix.length);
            return decodeDiagnostic(prefix);
        }
        return '';
    }
    end() { const text = decodeDiagnostic(this.pending); this.pending = Buffer.alloc(0); return text; }
}
exports.DiagnosticDecoder = DiagnosticDecoder;
async function readDiagnosticResponse(response) {
    const charset = response.headers.get('content-type')?.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
    return decodeDiagnostic(Buffer.from(await response.arrayBuffer()), charset);
}
//# sourceMappingURL=DiagnosticDecoder.js.map