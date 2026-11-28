export interface PetWindowHost {
    /** Show or hide the pet surface, applying the current config. */
    setVisible(visible: boolean): void;
    /** Push config changes (scale, always-on-top, shadow…) into the live window. */
    applyConfig(): void;
    /** Destroy the window and release it. */
    close(): void;
    isOpen(): boolean;
}
export declare function setPetWindowHost(next: PetWindowHost | null): void;
export declare function petWindowHost(): PetWindowHost | null;
//# sourceMappingURL=PetWindowHost.d.ts.map