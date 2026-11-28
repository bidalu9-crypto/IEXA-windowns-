/** Decode raw diagnostic bytes once. Valid UTF-8 (including literal U+FFFD)
 * must not be reinterpreted as GBK. A declared encoding takes precedence. */
export declare function decodeDiagnostic(bytes: Buffer, encoding?: string): string;
/** Line buffering keeps GBK/UTF-8 characters intact across arbitrary pipe
 * chunks. The cap bounds unbroken diagnostic lines from a noisy process. */
export declare class DiagnosticDecoder {
    private pending;
    write(chunk: Buffer): string;
    end(): string;
}
export declare function readDiagnosticResponse(response: Response): Promise<string>;
//# sourceMappingURL=DiagnosticDecoder.d.ts.map