export interface WorkspaceSearchResult {
    path: string;
    line: number;
    column: number;
    preview: string;
}
/**
 * Bounded, case-insensitive literal search (first occurrence per matching line).
 * Paths are root-relative with '/' separators; line/column are 1-based JS string
 * positions, previews are trimmed to 300 characters. Results use directory
 * discovery order, not read-completion order. limit is clamped to 0..100.
 *
 * At most 2500 eligible files, 1 MiB/file (+1-byte growth probe), eight concurrent
 * file jobs. Skips all hidden names (.git/.env/.iexa-* included), dependencies,
 * build output, secret/credential/token/auth names and private-key files.
 * Symlinks/junctions are not followed. This is a read filter, not OS isolation
 * against an adversary continuously replacing filesystem paths.
 *
 * Invalid/unreadable roots, blank queries and nonpositive limits return [].
 * Integrate with: await searchProjectText(projectRoot, query, limit).
 */
export declare function searchProjectText(root: string, query: string, limit?: number): Promise<WorkspaceSearchResult[]>;
//# sourceMappingURL=ProjectSearch.d.ts.map