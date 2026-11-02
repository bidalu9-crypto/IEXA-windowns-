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
  theme: 'light' | 'dark';
  accent: 'amber' | 'violet' | 'blue' | 'green' | 'rose' | 'mono';
  /** Interface language. Mirrored server-side so a new renderer origin (a random
   *  port, a fresh profile) does not silently fall back to the system language. */
  locale: 'zh-CN' | 'en-US' | 'ja-JP';
  sidebarWidth: number;
  filesPanelWidth: number;
  collapseConsecutiveTools: boolean;
  skinPreset: string;
  customSkin: { light: SkinPalette; dark: SkinPalette };
}

const LOCALES = ['zh-CN', 'en-US', 'ja-JP'] as const;

const ACCENTS = ['amber', 'violet', 'blue', 'green', 'rose', 'mono'] as const;
const SKIN_PRESETS = ['default', 'amber', 'violet', 'forest', 'rose', 'graphite', 'ocean', 'mint', 'custom'];

const DEFAULT_SKIN: { light: SkinPalette; dark: SkinPalette } = {
  light: { accent: '#6c63ff', canvas: '#f1ecec', surface: '#faf7f7', text: '', radius: 12 },
  dark: { accent: '#a5b4fc', canvas: '#211e1e', surface: '#2a2626', text: '', radius: 12 },
};

function normalizeSkinPalette(raw: unknown, fallback: SkinPalette): SkinPalette {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const colour = (value: unknown, preset: string) =>
    /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : preset;
  const radius = Number(source.radius);
  return {
    accent: colour(source.accent, fallback.accent),
    canvas: colour(source.canvas, fallback.canvas),
    surface: colour(source.surface, fallback.surface),
    text: /^#[0-9a-f]{6}$/i.test(String(source.text || '')) ? String(source.text).toLowerCase() : '',
    radius: Number.isFinite(radius) ? Math.round(Math.min(20, Math.max(6, radius))) : fallback.radius,
  };
}

export function normalizeAppearance(value: unknown): AppearanceSettings {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const width = (raw: unknown, fallback: number, min: number, max: number) => {
    const number = Number(raw);
    return Number.isFinite(number) ? Math.round(Math.min(max, Math.max(min, number))) : fallback;
  };
  const custom = source.customSkin && typeof source.customSkin === 'object'
    ? source.customSkin as Record<string, unknown>
    : {};
  return {
    fontScale: width(source.fontScale, 100, 100, 180),
    iconScale: width(source.iconScale, 100, 100, 160),
    theme: source.theme === 'light' ? 'light' : 'dark',
    motion: source.motion === 'system' || source.motion === 'reduced' ? source.motion : 'full',
    accent: ACCENTS.includes(String(source.accent) as typeof ACCENTS[number])
      ? String(source.accent) as AppearanceSettings['accent']
      : 'mono',
    sidebarWidth: width(source.sidebarWidth, 240, 180, 460),
    filesPanelWidth: width(source.filesPanelWidth, 300, 220, 560),
    collapseConsecutiveTools: source.collapseConsecutiveTools === true,
    locale: LOCALES.includes(String(source.locale) as typeof LOCALES[number])
      ? String(source.locale) as AppearanceSettings['locale']
      : 'zh-CN',
    skinPreset: SKIN_PRESETS.includes(String(source.skinPreset)) ? String(source.skinPreset) : 'graphite',
    customSkin: {
      light: normalizeSkinPalette(custom.light, DEFAULT_SKIN.light),
      dark: normalizeSkinPalette(custom.dark, DEFAULT_SKIN.dark),
    },
  };
}
