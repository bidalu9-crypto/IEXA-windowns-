/**
 * Artifacts shown in chat are persisted by path, but their bytes may live in a
 * scratch directory that is cleaned up later. These helpers keep the two
 * concerns apart: transient files can be displayed live, yet they must not
 * become permanent cards, and a restored card must never outlive its file.
 */
/** Resolve the way the tool layer records paths (absolute, or workspace-relative). */
export declare function resolveArtifactPath(workspaceDir: string, artifactPath: string): string;
/** `.tmp/` is scratch space: show it now, never keep it in the transcript. */
export declare function isTransientArtifact(workspaceDir: string, artifactPath: string): boolean;
/** A restored card is only valid while the file is still on disk. */
export declare function isServableArtifact(workspaceDir: string, artifactPath: string): boolean;
//# sourceMappingURL=ArtifactPolicy.d.ts.map