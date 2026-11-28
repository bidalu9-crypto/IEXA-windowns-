"use strict";
/**
 * Appearance settings: the shape the renderer persists, and the only place a
 * stored value is turned into a valid one. Kept out of server.ts so the request
 * handler stays a bootstrap.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeAppearance = normalizeAppearance;
const LOCALES = ['zh-CN', 'en-US', 'ja-JP'];
const ACCENTS = ['amber', 'violet', 'blue', 'green', 'rose', 'mono'];
const SKIN_PRESETS = ['default', 'amber', 'violet', 'forest', 'rose', 'graphite', 'ocean', 'mint', 'custom'];
const DEFAULT_SKIN = {
    light: { accent: '#6c63ff', canvas: '#f1ecec', surface: '#faf7f7', text: '', radius: 12 },
    dark: { accent: '#a5b4fc', canvas: '#211e1e', surface: '#2a2626', text: '', radius: 12 },
};
function normalizeSkinPalette(raw, fallback) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const colour = (value, preset) => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : preset;
    const radius = Number(source.radius);
    return {
        accent: colour(source.accent, fallback.accent),
        canvas: colour(source.canvas, fallback.canvas),
        surface: colour(source.surface, fallback.surface),
        text: /^#[0-9a-f]{6}$/i.test(String(source.text || '')) ? String(source.text).toLowerCase() : '',
        radius: Number.isFinite(radius) ? Math.round(Math.min(20, Math.max(6, radius))) : fallback.radius,
    };
}
function normalizeAppearance(value) {
    const source = value && typeof value === 'object' ? value : {};
    const width = (raw, fallback, min, max) => {
        const number = Number(raw);
        return Number.isFinite(number) ? Math.round(Math.min(max, Math.max(min, number))) : fallback;
    };
    const custom = source.customSkin && typeof source.customSkin === 'object'
        ? source.customSkin
        : {};
    return {
        fontScale: width(source.fontScale, 100, 100, 180),
        iconScale: width(source.iconScale, 100, 100, 160),
        theme: source.theme === 'light' ? 'light' : source.theme === 'auto' ? 'auto' : 'dark',
        motion: source.motion === 'system' || source.motion === 'reduced' ? source.motion : 'full',
        accent: ACCENTS.includes(String(source.accent))
            ? String(source.accent)
            : 'rose',
        sidebarWidth: width(source.sidebarWidth, 240, 180, 460),
        filesPanelWidth: width(source.filesPanelWidth, 300, 220, 560),
        collapseConsecutiveTools: source.collapseConsecutiveTools === true,
        locale: LOCALES.includes(String(source.locale))
            ? String(source.locale)
            : 'zh-CN',
        skinPreset: SKIN_PRESETS.includes(String(source.skinPreset)) ? String(source.skinPreset) : 'rose',
        customSkin: {
            light: normalizeSkinPalette(custom.light, DEFAULT_SKIN.light),
            dark: normalizeSkinPalette(custom.dark, DEFAULT_SKIN.dark),
        },
    };
}
//# sourceMappingURL=AppearanceSchema.js.map