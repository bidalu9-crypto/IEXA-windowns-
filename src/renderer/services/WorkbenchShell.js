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
  function isNaturalMode() {
    return window.IexaNaturalChat?.currentChatMode?.() === 'natural';
  }

  /** 她正在说话：模型在生成，或者已经生成完、正一句一句往外吐。 */
  function isSheSpeaking() {
    try {
      return window.IexaSessionView?.isNaturalSpeakingNow?.() === true;
    } catch {
      return false;
    }
  }

  function setCrumbText(crumb, speaking) {
    crumb.textContent = '';
    // i18n-exempt: 产品名与聊天约定，三种语言都写中文
    crumb.append(document.createTextNode('小楠'));
    if (!speaking) return;
    const typing = document.createElement('span');
    typing.className = 'breadcrumb-typing';
    typing.textContent = ' (对方正在输入...)';
    crumb.append(typing);
  }
  function syncProject() {
    const crumb = $('shellProjectCrumb');
    const divider = document.querySelector('.workbench-breadcrumb .breadcrumb-divider');
    const viewTitle = $('shellViewTitle');
    const icon = document.querySelector('.workbench-breadcrumb > svg');

    // 小楠模式没有「工作区 / 视图」这两层。她是一个人，不是一份文档——
    // 面包屑里只留她的名字，她说话的时候在后面挂一句正在输入。
    if (isNaturalMode()) {
      const speaking = isSheSpeaking();
      if (crumb) { crumb.classList.add('is-natural'); setCrumbText(crumb, speaking); }
      if (divider) divider.style.display = 'none';
      if (viewTitle) viewTitle.style.display = 'none';
      if (icon) icon.style.display = 'none';
      return;
    }

    if (crumb) crumb.classList.remove('is-natural');
    if (divider) divider.style.display = '';
    if (viewTitle) viewTitle.style.display = '';
    if (icon) icon.style.display = '';
    // The sidebar project row is gone; the workbench panel still owns the title.
    const title = $('filesPanelTitle')?.textContent?.trim();
    const open = title && title !== '项目'; // i18n-exempt: compares against the rendered project title
    if (crumb) crumb.textContent = open ? title : IexaI18n.t('wb.localWorkspace');
    if ($('filesPanelTitle')) $('filesPanelTitle').title = open ? title : IexaI18n.t('wb.project');
  }
  const observer = new MutationObserver(() => { syncView(); syncProject(); });
  document.querySelectorAll('.nav-btn').forEach((el) => observer.observe(el, { attributes: true, attributeFilter: ['class'] }));
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-chat-mode'] });
  const projectObserver = new MutationObserver(syncProject);
  if ($('filesPanelTitle')) projectObserver.observe($('filesPanelTitle'), { childList: true, subtree: true, characterData: true });
  // 正在输入是一个会自己开始、自己结束的状态，没有 DOM 变化可以观察：
  // 她的气泡是一条一条吐出来的，中间可能隔好几秒。低频轮询比监听每个气泡便宜。
  const typingTimer = window.setInterval(() => { if (isNaturalMode()) syncProject(); }, 700);
  syncView(); syncProject();
  window.addEventListener('pagehide', () => { observer.disconnect(); projectObserver.disconnect(); window.clearInterval(typingTimer); }, { once: true });
})();
