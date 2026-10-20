// Skin engine — turns three colours and a radius into the whole UI palette.
//
// A skin is deliberately small: the user picks an accent, a canvas and a
// surface; text, borders, hover states, halos and the action button are derived
// here so a custom skin can never produce unreadable defaults by accident.
//
// The engine owns the palette state and applies it as inline custom properties
// on <html>. Inline variables win over the [data-theme] / [data-accent] rules,
// which is exactly what a skin needs; switching back to "default" removes them.
(function () {
  const HEX = /^#[0-9a-f]{6}$/i;
  const PRESET_IDS = ['default', 'amber', 'violet', 'forest', 'rose', 'graphite', 'ocean', 'mint', 'custom'];
  const APPLIED = [
    '--accent', '--accent-hover', '--accent-light', '--on-accent',
    '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-input',
    '--text-primary', '--text-secondary', '--text-muted',
    '--border', '--border-strong',
    '--radius', '--radius-sm',
    '--action-bg', '--action-bg-hover', '--shadow',
  ];

  const presets = [
    {
      id: 'default', label: '默认',
      light: null, dark: null,
    },
    {
      id: 'amber', label: '暖沙',
      light: { accent: '#c4841d', canvas: '#f6f1e8', surface: '#fdf9f2', text: '', radius: 12 },
      dark: { accent: '#e5a33c', canvas: '#1f1b16', surface: '#292420', text: '', radius: 12 },
    },
    {
      id: 'violet', label: '紫罗兰',
      light: { accent: '#6c63ff', canvas: '#f1ecec', surface: '#faf7f7', text: '', radius: 12 },
      dark: { accent: '#a5b4fc', canvas: '#211e1e', surface: '#2a2626', text: '', radius: 12 },
    },
    {
      id: 'forest', label: '森林',
      light: { accent: '#2f7d5a', canvas: '#eef3ef', surface: '#f8fbf9', text: '', radius: 12 },
      dark: { accent: '#6bcf9a', canvas: '#171f1b', surface: '#1f2a24', text: '', radius: 12 },
    },
    {
      id: 'rose', label: '玫瑰',
      light: { accent: '#c2426a', canvas: '#f7edf0', surface: '#fdf8fa', text: '', radius: 12 },
      dark: { accent: '#f08aa8', canvas: '#221a1d', surface: '#2c2226', text: '', radius: 12 },
    },
    {
      id: 'graphite', label: '石墨',
      light: { accent: '#4b5563', canvas: '#eef0f2', surface: '#f9fafb', text: '', radius: 12 },
      dark: { accent: '#9ca3af', canvas: '#17181a', surface: '#1f2124', text: '', radius: 12 },
    },
    {
      id: 'ocean', label: '海洋',
      light: { accent: '#0f7490', canvas: '#ecf3f6', surface: '#f8fbfd', text: '', radius: 12 },
      dark: { accent: '#4cc2e0', canvas: '#101d23', surface: '#17272e', text: '', radius: 12 },
    },
    {
      id: 'mint', label: '薄荷',
      light: { accent: '#0f8a72', canvas: '#ecf6f3', surface: '#f7fcfb', text: '', radius: 12 },
      dark: { accent: '#4fd1b5', canvas: '#0f1d1a', surface: '#162824', text: '', radius: 12 },
    },
    {
      id: 'custom', label: '自定义',
      light: null, dark: null,
    },
  ];

  const DEFAULTS = {
    light: { accent: '#6c63ff', canvas: '#f1ecec', surface: '#faf7f7', text: '', radius: 12 },
    dark: { accent: '#a5b4fc', canvas: '#211e1e', surface: '#2a2626', text: '', radius: 12 },
  };

  const state = {
    preset: 'default',
    custom: { light: { ...DEFAULTS.light }, dark: { ...DEFAULTS.dark } },
  };
  const listeners = [];

  // MARK: - Colour math

  function rgb(hex) {
    const value = String(hex || '').replace('#', '');
    if (value.length !== 6 || !/^[0-9a-f]{6}$/i.test(value)) return null;
    return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
  }

  function hex(channels) {
    return '#' + channels.map((value) => {
      const n = Math.max(0, Math.min(255, Math.round(value)));
      return n.toString(16).padStart(2, '0');
    }).join('');
  }

  /** `weight` is the portion of `b` in the result. */
  function mix(a, b, weight) {
    const left = rgb(a), right = rgb(b);
    if (!left || !right) return a;
    const w = Math.max(0, Math.min(1, weight));
    return hex(left.map((value, index) => value * (1 - w) + right[index] * w));
  }

  function rgba(color, alpha) {
    const channels = rgb(color);
    if (!channels) return color;
    return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
  }

  function luminance(color) {
    const channels = rgb(color);
    if (!channels) return 0;
    const [r, g, b] = channels.map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrast(a, b) {
    const first = luminance(a), second = luminance(b);
    const high = Math.max(first, second), low = Math.min(first, second);
    return (high + 0.05) / (low + 0.05);
  }

  /** The readable ink for a filled surface: near-black or near-white. */
  function readableOn(color) {
    return contrast(color, '#141414') >= contrast(color, '#ffffff') ? '#141414' : '#ffffff';
  }

  /**
   * Ink for a filled control. White stays the default when it clears the 3:1
   * UI threshold — white on a saturated blue is the familiar look — and only
   * pastel fills that fail it switch to dark ink.
   */
  function inkOn(color) {
    return contrast(color, '#ffffff') >= 3 ? '#ffffff' : (contrast(color, '#141414') >= 3 ? '#141414' : '#ffffff');
  }

  function isLightColor(color) {
    return luminance(color) > 0.42;
  }

  // MARK: - Derivation

  /**
   * One palette -> the full set of custom properties. Pure: no DOM.
   * `mode` decides which direction hover states move and whether the action
   * button uses the accent or a deepened accent.
   */
  function derive(palette, mode) {
    const source = palette && typeof palette === 'object' ? palette : DEFAULTS.light;
    const accent = HEX.test(String(source.accent || '')) ? source.accent : DEFAULTS.light.accent;
    const canvas = HEX.test(String(source.canvas || '')) ? source.canvas : DEFAULTS.light.canvas;
    const surface = HEX.test(String(source.surface || '')) ? source.surface : DEFAULTS.light.surface;
    const radius = Math.max(6, Math.min(20, Math.round(Number(source.radius) || 12)));
    const dark = mode === 'dark';
    const text = HEX.test(String(source.text || '')) ? source.text : readableOn(surface);
    const lightCanvas = isLightColor(canvas);
    const accentHover = dark ? mix(accent, '#ffffff', 0.16) : mix(accent, '#000000', 0.14);
    const actionHover = dark ? mix(accent, '#ffffff', 0.28) : mix(accent, '#000000', 0.28);
    const tertiaryBase = mix(canvas, surface, 0.5);
    return {
      '--accent': accent,
      '--accent-hover': accentHover,
      '--accent-light': rgba(accent, dark ? 0.18 : 0.14),
      '--on-accent': inkOn(actionHover),
      '--bg-primary': canvas,
      '--bg-secondary': surface,
      '--bg-tertiary': mix(tertiaryBase, text, 0.05),
      '--bg-input': lightCanvas ? mix(surface, '#ffffff', 0.55) : mix(surface, '#ffffff', 0.05),
      '--text-primary': text,
      '--text-secondary': mix(text, surface, 0.32),
      '--text-muted': mix(text, surface, 0.56),
      '--border': mix(text, surface, 0.86),
      '--border-strong': mix(text, surface, 0.70),
      '--radius': radius + 'px',
      '--radius-sm': Math.max(4, radius - 4) + 'px',
      '--action-bg': dark ? accent : accentHover,
      '--action-bg-hover': actionHover,
      '--shadow': dark ? '0 4px 24px rgba(0, 0, 0, 0.42)' : '0 4px 24px rgba(23, 20, 20, 0.08)',
    };
  }

  // MARK: - State

  function normalizePalette(raw, fallback) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const take = (value, preset) => HEX.test(String(value || '')) ? String(value).toLowerCase() : preset;
    return {
      accent: take(source.accent, fallback.accent),
      canvas: take(source.canvas, fallback.canvas),
      surface: take(source.surface, fallback.surface),
      text: HEX.test(String(source.text || '')) ? String(source.text).toLowerCase() : '',
      radius: Math.max(6, Math.min(20, Math.round(Number(source.radius) || fallback.radius))),
    };
  }

  function normalize(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const custom = source.customSkin && typeof source.customSkin === 'object' ? source.customSkin : {};
    return {
      preset: PRESET_IDS.includes(String(source.skinPreset)) ? String(source.skinPreset) : 'default',
      custom: {
        light: normalizePalette(custom.light, DEFAULTS.light),
        dark: normalizePalette(custom.dark, DEFAULTS.dark),
      },
    };
  }

  function currentMode() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function activePalette() {
    if (state.preset === 'custom') return state.custom[currentMode()];
    const preset = presets.find((item) => item.id === state.preset);
    return preset ? preset[currentMode()] : null;
  }

  function emit() {
    for (const listener of listeners) {
      try { listener(snapshot()); } catch { /* a listener must not break painting */ }
    }
  }

  function snapshot() {
    return {
      skinPreset: state.preset,
      customSkin: {
        light: { ...state.custom.light },
        dark: { ...state.custom.dark },
      },
    };
  }

  // MARK: - DOM

  /** Read the palette that is actually painted, including [data-*] defaults. */
  function livePalette() {
    const style = getComputedStyle(document.documentElement);
    const read = (name, fallback) => {
      const text = String(style.getPropertyValue(name) || '').trim();
      if (HEX.test(text)) return text.toLowerCase();
      const match = text.match(/^rgba?\(([^)]+)\)$/);
      if (!match) return fallback;
      const parts = match[1].split(/[,\s/]+/).map(Number);
      return parts.length >= 3 ? hex(parts.slice(0, 3)) : fallback;
    };
    return {
      accent: read('--accent', DEFAULTS.light.accent),
      canvas: read('--bg-primary', DEFAULTS.light.canvas),
      surface: read('--bg-secondary', DEFAULTS.light.surface),
      text: '',
      radius: Math.round(parseFloat(style.getPropertyValue('--radius')) || 12),
    };
  }

  function apply() {
    const palette = activePalette();
    const root = document.documentElement;
    if (!palette) {
      for (const property of APPLIED) root.style.removeProperty(property);
      root.dataset.skin = 'default';
      return null;
    }
    const vars = derive(palette, currentMode());
    for (const [property, value] of Object.entries(vars)) root.style.setProperty(property, value);
    root.dataset.skin = state.preset;
    return vars;
  }

  function load(raw) {
    const next = normalize(raw);
    state.preset = next.preset;
    state.custom = next.custom;
    apply();
    emit();
  }

  function setPreset(id) {
    if (!PRESET_IDS.includes(id)) return;
    if (id === 'custom') {
      // Seed the custom palette from the preset that was showing, so choosing
      // "自定义" bends the current look instead of snapping to a stranger.
      const previous = activePalette();
      const mode = currentMode();
      if (previous) state.custom[mode] = normalizePalette(previous, DEFAULTS[mode]);
      else state.custom[mode] = { ...DEFAULTS[mode] };
    }
    state.preset = id;
    apply();
    emit();
  }

  /** Switching from a preset to custom keeps the whole preset, both modes. */
  function seedFrom(presetId) {
    if (presetId === 'custom') return;
    const preset = presets.find((item) => item.id === presetId);
    if (preset && preset.light && preset.dark) {
      state.custom.light = normalizePalette(preset.light, DEFAULTS.light);
      state.custom.dark = normalizePalette(preset.dark, DEFAULTS.dark);
      return;
    }
    const mode = currentMode();
    state.custom[mode] = normalizePalette(livePalette(), DEFAULTS[mode]);
  }

  function setColor(field, value) {
    if (!['accent', 'canvas', 'surface', 'text'].includes(field)) return;
    if (!HEX.test(String(value))) return;
    const mode = currentMode();
    seedFrom(state.preset);
    const base = normalizePalette(state.custom[mode], DEFAULTS[mode]);
    state.preset = 'custom';
    state.custom[mode] = { ...base, [field]: String(value).toLowerCase() };
    apply();
    emit();
  }

  function setRadius(value) {
    const mode = currentMode();
    seedFrom(state.preset);
    const base = normalizePalette(state.custom[mode], DEFAULTS[mode]);
    state.preset = 'custom';
    state.custom[mode] = { ...base, radius: Math.max(6, Math.min(20, Math.round(Number(value) || 12))) };
    apply();
    emit();
  }

  function resetCustom(mode) {
    const target = mode === 'dark' ? 'dark' : 'light';
    state.preset = 'custom';
    state.custom[target] = { ...DEFAULTS[target] };
    apply();
    emit();
  }

  function restoreDefault() {
    state.preset = 'default';
    state.custom = { light: { ...DEFAULTS.light }, dark: { ...DEFAULTS.dark } };
    apply();
    emit();
  }

  function exportPatch() {
    return {
      format: 'iexa-skin',
      version: 1,
      skinPreset: state.preset,
      customSkin: {
        light: { ...state.custom.light },
        dark: { ...state.custom.dark },
      },
    };
  }

  /** Accepts an exported patch; returns an error message or null. */
  function importPatch(raw) {
    const source = raw && typeof raw === 'object' ? raw : null;
    if (!source || source.format !== 'iexa-skin') return '这不是 IEXA 皮肤文件。';
    const custom = source.customSkin;
    if (!custom || typeof custom !== 'object') return '皮肤文件缺少配色数据。';
    const candidate = {
      skinPreset: PRESET_IDS.includes(String(source.skinPreset)) ? String(source.skinPreset) : 'custom',
      customSkin: custom,
    };
    load(candidate);
    return null;
  }

  window.IexaSkins = {
    presets,
    defaults: () => ({ light: { ...DEFAULTS.light }, dark: { ...DEFAULTS.dark } }),
    derive,
    contrast,
    readableOn,
    inkOn,
    livePalette,
    load,
    apply,
    snapshot,
    setPreset,
    setColor,
    setRadius,
    resetCustom,
    restoreDefault,
    exportPatch,
    importPatch,
    currentMode,
    activePalette,
    get state() { return { preset: state.preset, custom: JSON.parse(JSON.stringify(state.custom)) }; },
    onChange(listener) {
      if (typeof listener === 'function') listeners.push(listener);
    },
  };
})();
