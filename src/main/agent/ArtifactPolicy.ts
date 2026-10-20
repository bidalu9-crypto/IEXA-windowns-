import * as fs from 'fs';
import * as path from 'path';

/**
 * Artifacts shown in chat are persisted by path, but their bytes may live in a
 * scratch directory that is cleaned up later. These helpers keep the two
 * concerns apart: transient files can be displayed live, yet they must not
 * become permanent cards, and a restored card must never outlive its file.
 */

/** Resolve the way the tool layer records paths (absolute, or workspace-relative). */
export function resolveArtifactPath(workspaceDir: string, artifactPath: string): string {
  return path.isAbsolute(artifactPath) ? path.resolve(artifactPath) : path.resolve(workspaceDir, artifactPath);
}

/** `.tmp/` is scratch space: show it now, never keep it in the transcript. */
export function isTransientArtifact(workspaceDir: string, artifactPath: string): boolean {
  const relative = path.relative(path.resolve(workspaceDir), resolveArtifactPath(workspaceDir, artifactPath));
  return relative === '.tmp' || relative.startsWith('.tmp' + path.sep);
}

/** A restored card is only valid while the file is still on disk. */
export function isServableArtifact(workspaceDir: string, artifactPath: string): boolean {
  try {
    return fs.statSync(resolveArtifactPath(workspaceDir, artifactPath)).isFile();
  } catch {
    return false;
  }
}
