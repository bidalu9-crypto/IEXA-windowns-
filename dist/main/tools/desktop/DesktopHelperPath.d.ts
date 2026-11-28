interface DesktopHelperEnvironment {
    moduleDirectory?: string;
    resourcesPath?: string;
    execPath?: string;
}
export interface DesktopHelperBinary {
    executable?: string;
    dll?: string;
}
/** src/main/tools/desktop and dist/main/tools/desktop share this depth. */
export declare function desktopApplicationRoot(moduleDirectory?: string): string;
/** Only the running application/module and executable supply installation roots.
 * A project directory (or its parent/cwd) must never select another helper. */
export declare function desktopHelperCandidates(environment?: DesktopHelperEnvironment): string[];
/** Select one installation directory, keeping the apphost and DLL together. */
export declare function resolveDesktopHelper(environment?: DesktopHelperEnvironment): DesktopHelperBinary | undefined;
export {};
//# sourceMappingURL=DesktopHelperPath.d.ts.map