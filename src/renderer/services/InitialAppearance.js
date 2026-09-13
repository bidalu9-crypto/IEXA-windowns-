// Apply saved appearance before first paint without an inline script.
(function () {
  try {
    var saved = window.iexaDesktop && window.iexaDesktop.initialAppearance;
    var theme = saved && saved.theme || localStorage.getItem('iexa-theme') || 'light';
    var accent = saved && saved.accent || localStorage.getItem('iexa-accent') || 'violet';
    if (accent === 'opencode') accent = 'amber';
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-accent', accent);
  } catch (_) {}
})();
