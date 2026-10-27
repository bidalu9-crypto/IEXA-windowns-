/* Thin DOM adapter. Existing app controls remain the single action authority. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const forward = (from, to) => $(from)?.addEventListener('click', () => $(to)?.click());
  forward('shellNewThread', 'newSessionBtn');
  forward('shellProjectBtn', 'filesOpenBtn');
  forward('shellAddProject', 'filesOpenBtn');
  forward('shellOpenProject', 'filesOpenBtn');
  forward('shellFocusBtn', 'chatFocusToggle');
  function syncView() {
    const active = document.querySelector('.nav-btn.active');
    if ($('shellViewTitle')) $('shellViewTitle').textContent = active?.querySelector('span')?.textContent || IexaI18n.t('wb.chat');
    document.querySelectorAll('.nav-btn').forEach((button) => {
      if (button === active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (active?.closest('.sidebar-more')) $('sidebarMore').open = true;
    if ($('shellFocusBtn')) $('shellFocusBtn').setAttribute('aria-pressed', String(document.body.classList.contains('chat-focus-mode')));
  }
  function syncProject() {
    const title = $('filesPanelTitle')?.textContent?.trim();
    const open = title && title !== '项目'; // i18n-exempt: compares against the rendered project title
    $('shellProjectName').textContent = open ? title : IexaI18n.t('wb.openFolder');
    $('shellProjectCrumb').textContent = open ? title : IexaI18n.t('wb.localWorkspace');
    $('shellProjectBtn').title = open ? IexaI18n.t('wb.switchProject', { title }) : IexaI18n.t('wb.openFolder');
    $('shellProjectBtn').setAttribute('aria-label', open ? `${IexaI18n.t('wb.switchFolderTitle')}${title}` : IexaI18n.t('wb.openFolder'));
    if ($('filesPanelTitle')) $('filesPanelTitle').title = open ? title : IexaI18n.t('wb.project');
  }
  const observer = new MutationObserver(syncView);
  document.querySelectorAll('.nav-btn').forEach((el) => observer.observe(el, { attributes: true, attributeFilter: ['class'] }));
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  const projectObserver = new MutationObserver(syncProject);
  if ($('filesPanelTitle')) projectObserver.observe($('filesPanelTitle'), { childList: true, subtree: true, characterData: true });
  // Match the existing shortcut rather than adding a second task execution path.
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'n') {
      event.preventDefault(); $('newSessionBtn')?.click();
    }
  });
  syncView(); syncProject();
  window.addEventListener('pagehide', () => { observer.disconnect(); projectObserver.disconnect(); }, { once: true });
})();
