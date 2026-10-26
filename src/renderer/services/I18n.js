/* Minimal, dependency-free i18n layer.
 * - zh-CN is the source locale and the fallback for every missing key.
 * - Static markup opts in with data-i18n / data-i18n-placeholder / data-i18n-title / data-i18n-aria.
 * - Dynamic strings call IexaI18n.t('key', { count }).
 * The chosen locale persists in localStorage and is mirrored to <html lang/data-locale>.
 */
(function (root) {
  'use strict';

  const zh = {
    'nav.newTask': '新建任务',
    'nav.chat': '对话',
    'nav.skills': '技能',
    'nav.scheduled': '定时任务',
    'nav.more': '设置与拓展',
    'nav.appearance': '外观',
  'nav.pet': '桌面宠物',
  'nav.doc': '文档',
    'nav.soul': '灵魂',
    'nav.tokenUsage': '上下文洞察',
    'nav.mcp': 'MCP',
    'nav.plugins': '拓展',
    'nav.settings': '配置',
    'nav.sync': '设备与桥接',
    'nav.about': '关于',
    'nav.projects': '项目',
    'nav.openProject': '打开项目文件夹',
    'search.sessions': '搜索会话',
    'palette.placeholder': '输入命令，Enter 执行，Esc 关闭',
    'palette.empty': '没有匹配的命令',
    'palette.newSession': '新建任务',
    'palette.chat': '打开对话',
    'palette.skills': '打开技能',
    'palette.scheduled': '打开定时任务',
    'palette.mcp': '打开 MCP 服务',
    'palette.plugins': '打开插件',
    'palette.settings': '打开设置与扩展',
    'palette.appearance': '打开外观设置',
    'palette.tokenUsage': '打开 Token 用量',
    'palette.checkpoints': '检查点与回退',
    'palette.plan': '切换到只读规划模式',
    'palette.risk': '切换到帮我批准',
    'palette.diagnostics': '导出诊断包',
    'slash.help': '查看可用命令',
    'slash.new': '新建会话',
    'slash.model': '切换模型',
    'slash.plan': '切换到只读规划模式',
    'slash.rewind': '打开检查点与回退',
    'slash.diagnostics': '导出诊断包',
    'checkpoint.title': '检查点',
    'checkpoint.refresh': '刷新',
    'checkpoint.loading': '加载中…',
    'checkpoint.empty': '本次会话还没有文件修改记录',
    'checkpoint.noSession': '当前没有活动会话',
    'checkpoint.loadFailed': '加载失败：{message}',
    'checkpoint.restore': '回到这里',
    'checkpoint.files': '{count} 个文件',
    'checkpoint.unnamed': '未命名请求',
    'checkpoint.confirm': '回退会撤销该检查点之后的所有文件修改；若文件已被其他程序改动，操作会中止并保留历史。',
    'diagnostics.title': '诊断',
    'diagnostics.hint': '导出运行指标、版本信息与设备环境（不含密钥），便于排查问题。',
    'diagnostics.export': '导出诊断包',
    'diagnostics.exporting': '正在导出…',
    'diagnostics.done': '已导出：{path}（{size} KB）',
    'diagnostics.failed': '导出失败：{message}',
    'permission.plan': '仅规划（只读）',
    'permission.ask': '请求批准',
    'permission.risk': '帮我批准',
    'permission.full': '完全访问',
    'tool.project_instructions': '读取项目指令',
    'tool.desktop_control': '桌面控制',
    'tool.todo_write': '更新计划',
    'tool.ask_user': '向用户提问',
    'tool.shell_execute': '执行命令',
    'tool.file_read': '读取文件',
    'tool.file_write': '写入文件',
    'tool.file_edit': '编辑文件',
    'tool.grep': '搜索代码',
    'tool.glob': '查找文件',
    'tool.browser_fetch': '抓取网页',
    'tool.memory_write': '写入记忆',
    'tool.memory_get': '读取记忆',
    'locale.label': '界面语言',
  };

  const en = {
    'nav.newTask': 'New task',
    'nav.chat': 'Chat',
    'nav.skills': 'Skills',
    'nav.scheduled': 'Scheduled',
    'nav.more': 'Settings & extensions',
    'nav.appearance': 'Appearance',
  'nav.pet': 'Desktop pet',
  'nav.doc': 'Documents',
    'nav.soul': 'Soul',
    'nav.tokenUsage': 'Context insights',
    'nav.mcp': 'MCP',
    'nav.plugins': 'Extensions',
    'nav.settings': 'Settings',
    'nav.sync': 'Devices & bridge',
    'nav.about': 'About',
    'nav.projects': 'Projects',
    'nav.openProject': 'Open project folder',
    'search.sessions': 'Search sessions',
    'palette.placeholder': 'Type a command, Enter to run, Esc to close',
    'palette.empty': 'No matching commands',
    'palette.newSession': 'New task',
    'palette.chat': 'Open chat',
    'palette.skills': 'Open skills',
    'palette.scheduled': 'Open scheduled tasks',
    'palette.mcp': 'Open MCP servers',
    'palette.plugins': 'Open plugins',
    'palette.settings': 'Open settings & extensions',
    'palette.appearance': 'Open appearance settings',
    'palette.tokenUsage': 'Open token usage',
    'palette.checkpoints': 'Checkpoints & rewind',
    'palette.plan': 'Switch to read-only plan mode',
    'palette.risk': 'Switch to risk-based approval',
    'palette.diagnostics': 'Export diagnostics',
    'slash.help': 'Show available commands',
    'slash.new': 'New session',
    'slash.model': 'Switch model',
    'slash.plan': 'Switch to read-only plan mode',
    'slash.rewind': 'Open checkpoints & rewind',
    'slash.diagnostics': 'Export diagnostics',
    'checkpoint.title': 'Checkpoints',
    'checkpoint.refresh': 'Refresh',
    'checkpoint.loading': 'Loading…',
    'checkpoint.empty': 'This session has no file changes yet',
    'checkpoint.noSession': 'No active session',
    'checkpoint.loadFailed': 'Load failed: {message}',
    'checkpoint.restore': 'Restore here',
    'checkpoint.files': '{count} file(s)',
    'checkpoint.unnamed': 'Untitled request',
    'checkpoint.confirm': 'Restoring undoes every file change made after this checkpoint. If a file was changed by another program, the restore aborts and history is kept.',
    'diagnostics.title': 'Diagnostics',
    'diagnostics.hint': 'Export runtime metrics, version information and environment details (no secrets) for troubleshooting.',
    'diagnostics.export': 'Export diagnostics',
    'diagnostics.exporting': 'Exporting…',
    'diagnostics.done': 'Exported: {path} ({size} KB)',
    'diagnostics.failed': 'Export failed: {message}',
    'permission.plan': 'Plan only (read-only)',
    'permission.ask': 'Always ask',
    'permission.risk': 'Approve risky actions',
    'permission.full': 'Full access',
    'tool.project_instructions': 'Read project instructions',
    'tool.desktop_control': 'Desktop control',
    'tool.todo_write': 'Update plan',
    'tool.ask_user': 'Ask the user',
    'tool.shell_execute': 'Run command',
    'tool.file_read': 'Read file',
    'tool.file_write': 'Write file',
    'tool.file_edit': 'Edit file',
    'tool.grep': 'Search code',
    'tool.glob': 'Find files',
    'tool.browser_fetch': 'Fetch web page',
    'tool.memory_write': 'Write memory',
    'tool.memory_get': 'Read memory',
    'locale.label': 'Interface language',
  };

  const ui = (typeof window !== 'undefined' && window.IexaI18nUi) || { zh: {}, en: {}, ja: {} };
  Object.assign(zh, ui.zh);
  const en2 = Object.assign(en, ui.en);
  const ja = ui.ja;

  const dictionaries = { 'zh-CN': zh, 'en-US': en, 'ja-JP': ja };
  void en2;
  const listeners = new Set();
  let locale = 'zh-CN';

  function normalize(value) {
    const raw = String(value || '').toLowerCase();
    if (raw.startsWith('ja')) return 'ja-JP';
    return raw.startsWith('en') ? 'en-US' : 'zh-CN';
  }

  function t(key, params) {
    const table = dictionaries[locale] || {};
    let value = table[key];
    if (value === undefined) value = dictionaries['zh-CN'][key];
    if (value === undefined) value = key;
    if (params) {
      value = String(value).replace(/\{(\w+)\}/g, (match, name) =>
        (params[name] === undefined || params[name] === null ? match : String(params[name])));
    }
    return value;
  }

  function apply(scope) {
    const target = scope || document;
    if (!target || typeof target.querySelectorAll !== 'function') return;
    target.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    target.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    target.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    target.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  }

  function setLocale(next, options) {
    locale = normalize(next);
    try { localStorage.setItem('iexa-locale', locale); } catch { /* private mode */ }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
      document.documentElement.dataset.locale = locale;
      if (!options || options.apply !== false) apply(document);
    }
    for (const listener of listeners) {
      try { listener(locale); } catch { /* a listener must not break switching */ }
    }
    return locale;
  }

  function detect() {
    try {
      const saved = localStorage.getItem('iexa-locale');
      if (saved) return normalize(saved);
    } catch { /* private mode */ }
    return normalize((typeof navigator !== 'undefined' && navigator.language) || 'zh-CN');
  }

  function init() {
    setLocale(detect(), { apply: false });
    return locale;
  }

  function onLocaleChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  root.IexaI18n = Object.freeze({
    t, init, setLocale, getLocale: () => locale, apply, onLocaleChange, normalize, dictionaries,
  });
})(typeof window !== 'undefined' ? window : globalThis);
