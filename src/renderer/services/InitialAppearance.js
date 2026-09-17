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
  } catch (_) {}
})();
