/* Thin DOM adapter. Existing app controls remain the single action authority. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const forward = (from, to) => $(from)?.addEventListener('click', () => $(to)?.click());
  forward('shellNewThread', 'newSessionBtn');
  forward('shellProjectBtn', 'filesOpenBtn');
  forward('shellOpenProject', 'filesOpenBtn');
  forward('shellFocusBtn', 'chatFocusToggle');
  function syncView() {
    const active = document.querySelector('.nav-btn.active');
    if ($('shellViewTitle')) $('shellViewTitle').textContent = active?.querySelector('span')?.textContent || '对话';
    document.querySelectorAll('.nav-btn').forEach((button) => {
      if (button === active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (active?.closest('.sidebar-more')) $('sidebarMore').open = true;
    if ($('shellFocusBtn')) $('shellFocusBtn').setAttribute('aria-pressed', String(document.body.classList.contains('chat-focus-mode')));
  }
  function syncProject() {
    const title = $('filesPanelTitle')?.textContent?.trim();
    const open = title && title !== '项目';
    $('shellProjectName').textContent = open ? title : '打开项目文件夹';
    $('shellProjectCrumb').textContent = open ? title : '本地工作区';
    $('shellProjectBtn').title = open ? `${title} · 切换项目文件夹` : '打开项目文件夹';
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
