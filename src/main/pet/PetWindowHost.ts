// =============================================================================
// IEXA - Desktop pet window host
//
// The HTTP server owns the pet's data but not the window: only the Electron main
// process can create a transparent, always-on-top surface. This module is the
// seam between them — the server registers a host at startup and every route
// talks to it through this interface, so the server keeps working in plain Node
// (tests, `npm start`) where no host is installed.
// =============================================================================
export interface PetWindowHost {
  /** Show or hide the pet surface, applying the current config. */
  setVisible(visible: boolean): void;
  /** Push config changes (scale, always-on-top, shadow…) into the live window. */
  applyConfig(): void;
  /** Destroy the window and release it. */
  close(): void;
  isOpen(): boolean;
}

let host: PetWindowHost | null = null;

export function setPetWindowHost(next: PetWindowHost | null): void {
  host = next;
}

export function petWindowHost(): PetWindowHost | null {
  return host;
}
