// Apply saved appearance before first paint without an inline script.
(function () {
  try {
    if (window.iexaDesktop?.initialWindowState?.custom) document.documentElement.dataset.windowChrome = 'custom';
    var saved = window.iexaDesktop && window.iexaDesktop.initialAppearance;
    window.IexaUiScale?.apply({fontScale:saved?.fontScale ?? localStorage.getItem('iexa-font-scale') ?? 100,iconScale:saved?.iconScale ?? localStorage.getItem('iexa-icon-scale') ?? 100},false);
    var theme = saved && saved.theme || localStorage.getItem('iexa-theme') || 'light';
    var accent = saved && saved.accent || localStorage.getItem('iexa-accent') || 'violet';
    var motion = saved && saved.motion || localStorage.getItem('iexa-motion') || 'system';
    document.documentElement.setAttribute('data-motion', ['system', 'full', 'reduced'].includes(motion) ? motion : 'system');
    if (accent === 'opencode') accent = 'amber';
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-accent', accent);
    document.documentElement.setAttribute('data-collapse-tools', (saved && saved.collapseConsecutiveTools === true) || localStorage.getItem('iexa-collapse-tools') === 'on' ? 'on' : 'off');
    // Liquid Glass layer. On by default; `styles/glass.css` turns itself into a
    // flat palette when the OS asks for reduced transparency, so an enabled
    // desktop gets the material and a disabled one gets plain surfaces.
    var glass = localStorage.getItem('iexa-glass');
    document.documentElement.setAttribute('data-glass', glass === 'off' ? 'off' : 'on');
    // A switch belongs to the appearance surface, but the attribute has to be
    // settable from anywhere (settings page, console, tests) without reloading
    // the whole window.
    window.IexaGlass = {
      get: function () { return document.documentElement.getAttribute('data-glass') !== 'off'; },
      set: function (value) {
        var on = value !== false && value !== 'off';
        document.documentElement.setAttribute('data-glass', on ? 'on' : 'off');
        try { localStorage.setItem('iexa-glass', on ? 'on' : 'off'); } catch (_) {}
        return on;
      },
      toggle: function () { return window.IexaGlass.set(!window.IexaGlass.get()); },
    };
    // A saved skin must paint before the first frame, or the app flashes the
    // default palette on every launch.
    var skin = null;
    try { skin = JSON.parse(localStorage.getItem('iexa-skin') || 'null'); } catch (_) { skin = null; }
    if (skin && window.IexaSkins) window.IexaSkins.load(skin);
  } catch (_) {}
})();
