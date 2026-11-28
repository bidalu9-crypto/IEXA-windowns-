/**
 * Appearance settings: the shape the renderer persists, and the only place a
 * stored value is turned into a valid one. Kept out of server.ts so the request
 * handler stays a bootstrap.
 */
export interface SkinPalette {
    accent: string;
    canvas: string;
    surface: string;
    text: string;
    radius: number;
}
export interface AppearanceSettings {
    fontScale: number;
    iconScale: number;
    motion: 'system' | 'full' | 'reduced';
    /** The stored choice, never the resolved colour: `auto` follows the operating
     *  system and is re-resolved by the renderer whenever Windows flips. */
    theme: 'light' | 'dark' | 'auto';
    accent: 'amber' | 'violet' | 'blue' | 'green' | 'rose' | 'mono';
    /** Interface language. Mirrored server-side so a new renderer origin (a random
     *  port, a fresh profile) does not silently fall back to the system language. */
    locale: 'zh-CN' | 'en-US' | 'ja-JP';
    sidebarWidth: number;
    filesPanelWidth: number;
    collapseConsecutiveTools: boolean;
    skinPreset: string;
    customSkin: {
        light: SkinPalette;
        dark: SkinPalette;
    };
}
export declare function normalizeAppearance(value: unknown): AppearanceSettings;
//# sourceMappingURL=AppearanceSchema.d.ts.map