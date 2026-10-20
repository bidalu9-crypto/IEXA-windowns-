// Appearance page — skins, scale, motion and the live preview.
//
// The page is a thin view over IexaSkins: every control writes to the engine,
// the engine paints <html>, and the preview (which lives inside the same
// document) re-renders itself from the tokens. Nothing here knows about colour
// math, and the engine knows nothing about DOM controls.
(function () {
  let mounted = false;
  let savedTimer = null;

  const $ = (id) => document.getElementById(id);

  function paletteForEditor() {
    return window.IexaSkins.activePalette() || window.IexaSkins.livePalette();
  }

  const BASE_TILES = {
    light: { canvas: '#f1ecec', surface: '#faf7f7', radius: 12 },
    dark: { canvas: '#211e1e', surface: '#2a2626', radius: 12 },
  };
  const ACCENT_HEX = { amber: '#c4841d', violet: '#60a5fa', blue: '#2563eb', green: '#16a34a', rose: '#e11d48', mono: '#4b4646' };

  function paletteForTile(preset, mode) {
    if (preset.id === 'custom') return window.IexaSkins.state.custom[mode];
    if (preset.id === 'default') {
      const accent = ACCENT_HEX[document.documentElement.getAttribute('data-accent')] || '#60a5fa';
      return { ...BASE_TILES[mode], accent };
    }
    return preset[mode];
  }

  function renderSkinGrid() {
    const grid = $('skinGrid');
    if (!grid) return;
    const mode = window.IexaSkins.currentMode();
    const active = window.IexaSkins.state.preset;
    grid.innerHTML = window.IexaSkins.presets.map((preset) => {
      const palette = paletteForTile(preset, mode);
      const style = palette
        ? `--tile-canvas:${palette.canvas};--tile-surface:${palette.surface};--tile-accent:${palette.accent};--tile-radius:${palette.radius}px`
        : '';
      const custom = preset.id === 'custom' ? ' is-custom' : '';
      const selected = preset.id === active;
      return `<button type="button" class="skin-tile${custom}${selected ? ' is-active' : ''}" data-skin-id="${preset.id}"
        style="${style}" aria-pressed="${selected}" title="${preset.label}">
        <span class="skin-tile-art" aria-hidden="true"><i class="skin-tile-bar"></i><i class="skin-tile-dot"></i></span>
        <span class="skin-tile-label">${preset.label}</span>
        <span class="skin-tile-check" aria-hidden="true">${uiIcon('check')}</span>
      </button>`;
    }).join('');
    grid.querySelectorAll('[data-skin-id]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.dataset.skinId;
        window.IexaSkins.setPreset(id);
        // The grid repaints from state, so restore focus to the equivalent tile.
        grid.querySelector(`[data-skin-id="${id}"]`)?.focus();
      });
    });
  }

  function syncColorPair(field, colorId, hexId) {
    const palette = paletteForEditor();
    const value = (palette && palette[field]) || '#000000';
    const color = $(colorId);
    const text = $(hexId);
    if (color && color.value.toLowerCase() !== value) color.value = value;
    if (text && document.activeElement !== text && text.value.toLowerCase() !== value) text.value = value;
  }

  function syncEditor() {
    const mode = window.IexaSkins.currentMode();
    const preset = window.IexaSkins.state.preset;
    const label = $('skinEditorMode');
    if (label) {
      label.textContent = preset === 'default'
        ? `默认主题 · 编辑任一颜色即创建自定义${mode === 'dark' ? '深色' : '浅色'}皮肤`
        : `正在编辑${mode === 'dark' ? '深色' : '浅色'}配色`;
    }
    syncColorPair('accent', 'skinAccent', 'skinAccentHex');
    syncColorPair('canvas', 'skinCanvas', 'skinCanvasHex');
    syncColorPair('surface', 'skinSurface', 'skinSurfaceHex');
    const palette = paletteForEditor();
    const radius = palette ? palette.radius : 12;
    const range = $('skinRadius');
    const output = $('skinRadiusValue');
    if (range && Number(range.value) !== radius) range.value = String(radius);
    if (output) output.textContent = radius + 'px';
    const legacy = $('accentPresetRow');
    if (legacy) legacy.hidden = preset !== 'default';
    const editor = $('skinEditor');
    if (editor) editor.classList.toggle('is-inheriting', preset === 'default');
  }

  function renderContrast() {
    const report = $('contrastReport');
    if (!report) return;
    // Read what the browser actually resolved: this covers the default theme
    // (stylesheet values) and a skin (inline values) with the same code path.
    const style = getComputedStyle(document.documentElement);
    const text = window.IexaSkins.contrast(
      toHex(style.getPropertyValue('--text-primary')),
      toHex(style.getPropertyValue('--bg-secondary')),
    );
    const button = window.IexaSkins.contrast(
      toHex(style.getPropertyValue('--on-accent')),
      toHex(style.getPropertyValue('--action-bg')),
    );
    const badge = (label, value, threshold) => {
      const ok = value >= threshold;
      return `<span class="contrast-pill${ok ? '' : ' is-warn'}" title="${label}对比度 ${value.toFixed(2)}:1（建议 ≥ ${threshold}:1）">
        <i aria-hidden="true"></i>${label} <b>${value.toFixed(1)}:1</b></span>`;
    };
    report.innerHTML = badge('正文', text, 4.5) + badge('按钮', button, 3);
  }

  /** Computed colours arrive as rgb(); the engine expects hex. */
  function toHex(value) {
    const text = String(value || '').trim();
    if (text.startsWith('#')) return text;
    const match = text.match(/^rgba?\(([^)]+)\)$/);
    if (!match) return '#000000';
    const parts = match[1].split(/[,\s/]+/).map(Number);
    return '#' + parts.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(n || 0))).toString(16).padStart(2, '0')).join('');
  }

  function sync() {
    if (!mounted) return;
    renderSkinGrid();
    syncEditor();
    paintRanges();
    renderContrast();
  }

  /** Fill the track up to the thumb; CSS alone cannot read a range value. */
  function paintRange(input) {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const value = Number(input.value);
    const span = max - min;
    const percent = span > 0 ? Math.max(0, Math.min(100, ((value - min) / span) * 100)) : 0;
    input.style.setProperty('--range-progress', percent + '%');
  }

  function paintRanges() {
    document.querySelectorAll('.appearance-page input[type="range"]').forEach(paintRange);
  }

  function flashSaved() {
    const pill = $('appearanceSaved');
    if (!pill) return;
    pill.hidden = false;
    pill.classList.add('is-visible');
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      pill.classList.remove('is-visible');
      setTimeout(() => { pill.hidden = true; }, 220);
    }, 1400);
  }

  function bindColor(colorId, hexId, field) {
    const color = $(colorId);
    const text = $(hexId);
    color?.addEventListener('input', () => window.IexaSkins.setColor(field, color.value));
    text?.addEventListener('input', () => {
      const value = text.value.trim();
      if (/^#[0-9a-f]{6}$/i.test(value)) window.IexaSkins.setColor(field, value);
    });
    text?.addEventListener('blur', () => syncEditor());
  }

  function downloadSkin() {
    const patch = window.IexaSkins.exportPatch();
    const blob = new Blob([JSON.stringify(patch, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `iexa-skin-${patch.skinPreset}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importSkin(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const error = window.IexaSkins.importPatch(JSON.parse(text));
      if (error) await window.IexaDialogs?.alert?.(error);
    } catch {
      await window.IexaDialogs?.alert?.('无法读取这个皮肤文件，请确认它是从 IEXA 导出的 JSON。');
    }
  }

  function init() {
    if (mounted) return;
    mounted = true;
    renderSkinGrid();
    bindColor('skinAccent', 'skinAccentHex', 'accent');
    bindColor('skinCanvas', 'skinCanvasHex', 'canvas');
    bindColor('skinSurface', 'skinSurfaceHex', 'surface');
    $('skinRadius')?.addEventListener('input', (event) => window.IexaSkins.setRadius(Number(event.target.value)));
    // Paint the fill for every slider on the page, including the scale ones
    // owned by app.js.
    document.querySelectorAll('.appearance-page input[type="range"]').forEach((input) => {
      input.addEventListener('input', () => paintRange(input));
    });
    $('skinReset')?.addEventListener('click', () => window.IexaSkins.resetCustom(window.IexaSkins.currentMode()));
    $('skinExport')?.addEventListener('click', downloadSkin);
    $('skinImport')?.addEventListener('click', () => $('skinImportFile')?.click());
    $('skinImportFile')?.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      void importSkin(file);
    });
    window.IexaSkins.onChange(() => sync());
    sync();
  }

  window.IexaAppearanceView = { init, sync, flashSaved };
})();
