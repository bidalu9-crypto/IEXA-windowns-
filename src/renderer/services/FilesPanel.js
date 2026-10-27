// =============================================================================
// Project files panel
//
// OpenCode-style workspace browser: project root, git status, file list,
// checkpoints and previews.
//
// Classic script, extracted verbatim from app.js. Top-level declarations land
// in the global lexical environment, so app.js and the other services keep
// calling these by bare name. index.html fixes the load order; nothing here
// touches the DOM at load time.
// =============================================================================
let projectRoot = null;
let projectName = null;
let projectRecent = [];
let filesCurrentPath = '.';
let filesSelectedPath = '';
let filesPollTimer = null;
let filesLastSig = '';
let workbenchView = 'files';
let workspaceSearchTimer = null;
let workspaceSearchEpoch = 0;
let gitLoadInFlight = false;
let gitLoadEpoch = 0;
let gitStatusSignature = '';
let gitReloadRequested = false;

function formatFileSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function switchWorkbenchView(view) {
  if (!['files', 'git', 'search', 'terminal'].includes(view)) return;
  workbenchView = view;
  if (view !== 'git') gitReloadRequested = false;
  const filesList = document.getElementById('filesList');
  const filesPreview = document.getElementById('filesPreview');
  const gitPanel = document.getElementById('gitPanel');
  const searchPanel = document.getElementById('searchPanel');
  const terminalPanel = document.getElementById('terminalPanel');
  if (filesList) filesList.style.display = view === 'files' ? '' : 'none';
  if (filesPreview) filesPreview.style.display = view === 'files' && filesPreview.dataset.open === 'true' ? 'flex' : 'none';
  if (gitPanel) gitPanel.style.display = view === 'git' ? 'block' : 'none';
  if (searchPanel) searchPanel.style.display = view === 'search' ? 'flex' : 'none';
  if (terminalPanel) terminalPanel.style.display = view === 'terminal' ? 'flex' : 'none';
  document.querySelectorAll('.workbench-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.workbenchView === view);
  });
  if (view === 'git') loadGitWorkbench();
  if (view === 'search') document.getElementById('workspaceSearchInput')?.focus();
  if (view === 'terminal') loadTerminalSessions();
}

function renderGitStatus(data) {
  const panel = document.getElementById('gitPanel');
  if (!panel) return;
  const commitDraft = panel.querySelector('#gitCommitMessage')?.value || '';
  if (!projectRoot) {
    panel.innerHTML = '<div class="workbench-empty">' + IexaI18n.t('git.openProjectHint') + '</div>';
    return;
  }
  if (!data.available || data.error) {
    panel.innerHTML = `<div class="workbench-empty">${escapeHtml(data.error || IexaI18n.t('git.statusUnavailable'))}</div>`;
    return;
  }
  if (!data.repository) {
    panel.innerHTML = '<div class="workbench-empty">' + IexaI18n.t('git.notRepo') + '</div>';
    return;
  }
  const files = data.files || [];
  const branches = data.branches || [];
  const commits = data.commits || [];
  const counts = [];
  if (Number.isFinite(data.ahead) && data.ahead) counts.push(`↑${data.ahead}`);
  if (Number.isFinite(data.behind) && data.behind) counts.push(`↓${data.behind}`);
  const fileHtml = files.length ? files.map((file) => {
    const staged = file.index && file.index !== ' ';
    const working = file.workTree && file.workTree !== ' ';
    const label = `${staged ? file.index : ' '}${working ? file.workTree : ' '}`.trim() || '??';
    const action = `${staged
      ? '<button type="button" class="git-file-action" data-git-action="unstage">' + IexaI18n.t('git.unstage') + '</button>'
      : '<button type="button" class="git-file-action" data-git-action="stage">' + IexaI18n.t('git.stage') + '</button>'}${working ? '<button type="button" class="git-file-action git-file-restore" data-git-action="restore">' + IexaI18n.t('git.restore') + '</button>' : ''}`;
    return `<div class="git-file" data-path="${escapeHtml(file.path)}" data-staged="${staged && !working ? '1' : '0'}">
      <span class="git-file-status${staged ? ' is-staged' : ''}">${escapeHtml(label)}</span>
      <span class="git-file-path" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</span>
      <span class="git-file-actions">${action}</span>
    </div>`;
  }).join('') : '<div class="workbench-empty">' + IexaI18n.t('git.clean') + '</div>';
  const branchOptions = branches.map((branch) => `<option value="${escapeHtml(branch.name)}"${branch.current ? ' selected' : ''}>${escapeHtml(branch.name)}</option>`).join('');
  const commitHtml = commits.length ? commits.map((commit) => `<div class="git-log-entry" title="${escapeHtml(`${commit.hash}\n${commit.author}\n${commit.committedAt}`)}"><code>${escapeHtml(commit.shortHash)}</code><span>${escapeHtml(commit.subject)}</span></div>`).join('') : '<div class="git-log-empty">' + IexaI18n.t('git.noCommits') + '</div>';
  panel.innerHTML = `
    <div class="git-overview">
      <span class="git-branch" title="${escapeHtml(data.branch || '')}">⌥ ${escapeHtml(data.branch || '(detached HEAD)')}</span>
      <span class="git-counts">${escapeHtml(counts.join(' ') || (files.length ? IexaI18n.t('git.changedFiles', { count: files.length }) : IexaI18n.t('git.synced')))}</span>
    </div>
    <div class="git-toolbar">
      <select id="gitBranchSelect" aria-label="${IexaI18n.t('git.switchBranch')}">${branchOptions || `<option>${escapeHtml(data.branch || '(detached HEAD)')}</option>`}</select>
      <button type="button" data-git-operation="create-branch" title="${IexaI18n.t('git.createBranch')}">＋</button>
      <button type="button" data-git-operation="pull" title="${IexaI18n.t('git.pull')}">↓</button>
      <button type="button" data-git-operation="push" title="${IexaI18n.t('git.push')}">↑</button>
    </div>
    ${files.length ? `<div class="git-section-label">${IexaI18n.t('git.changesLabel')}${files.length})</div>${fileHtml}` : fileHtml}
    ${files.length ? `<div class="git-commit-box"><button type="button" class="git-stage-all" data-git-operation="stage-all">${IexaI18n.t('git.stageAll')}</button><textarea id="gitCommitMessage" rows="2" placeholder="${IexaI18n.t('git.commitMessage')}"></textarea><button type="button" class="git-commit-submit" data-git-operation="commit">${IexaI18n.t('git.commit')}</button></div>` : ''}
    <div class="git-section-label">${IexaI18n.t('git.recentCommits')}</div>
    <div class="git-log">${commitHtml}</div>
    <div id="gitDiffHost"></div>
  `;
  panel.querySelectorAll('.git-file').forEach((row) => {
    row.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-git-action]');
      const target = row.dataset.path;
      if (!target) return;
      if (action) {
        event.stopPropagation();
        if (action.dataset.gitAction === 'restore' && !(await window.IexaDialogs.confirm(IexaI18n.t('git.confirmRestore', { path: target })))) return;
        runGitMutation(action.dataset.gitAction, target);
      } else {
        openGitDiff(target, row.dataset.staged === '1');
      }
    });
  });
  panel.querySelector('#gitBranchSelect')?.addEventListener('change', (event) => {
    runGitOperation('switch', { branch: event.target.value });
  });
  panel.querySelectorAll('[data-git-operation]').forEach((button) => {
    button.addEventListener('click', async () => {
      const operation = button.dataset.gitOperation;
      if (operation === 'create-branch') {
        const branch = (await window.IexaDialogs.prompt(IexaI18n.t('git.newBranchPrompt')));
        if (branch && branch.trim()) runGitOperation(operation, { branch: branch.trim() });
        return;
      }
      if (operation === 'commit') {
        const message = panel.querySelector('#gitCommitMessage')?.value || '';
        runGitOperation(operation, { message });
        return;
      }
      runGitOperation(operation, {});
    });
  });
  const commitInput = panel.querySelector('#gitCommitMessage');
  if (commitInput && commitDraft) commitInput.value = commitDraft;
}

function gitStatusSignatureOf(data) {
  const files = (data.files || []).map((file) => `${file.path}\0${file.index}\0${file.workTree}`).join('\1');
  const commits = (data.commits || []).map((commit) => `${commit.hash}\0${commit.subject}`).join('\1');
  return [data.repository ? '1' : '0', data.branch || '', data.ahead ?? '', data.behind ?? '', files, commits].join('\2');
}

async function loadGitWorkbench(force = false) {
  if (workbenchView !== 'git') return;
  const panel = document.getElementById('gitPanel');
  if (!panel) return;
  if (!projectRoot) { renderGitStatus({}); return; }
  if (gitLoadInFlight) {
    if (force) gitReloadRequested = true;
    return;
  }
  gitLoadInFlight = true;
  const epoch = ++gitLoadEpoch;
  try {
    const response = await fetch(`${API_BASE}/api/git/status`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || IexaI18n.t('git.readStatusFailed'));
    if (data.repository) {
      const [branchesResponse, logResponse] = await Promise.all([
        fetch(`${API_BASE}/api/git/branches`),
        fetch(`${API_BASE}/api/git/log?limit=12`),
      ]);
      const branchesData = await branchesResponse.json();
      const logData = await logResponse.json();
      if (branchesResponse.ok) data.branches = branchesData.branches || [];
      if (logResponse.ok) data.commits = logData.entries || [];
    }
    if (epoch !== gitLoadEpoch || workbenchView !== 'git') return;
    const signature = gitStatusSignatureOf(data);
    // Do not rebuild the panel when polling sees the same repository state.
    // This keeps an open diff and an in-progress commit message intact.
    if (!force && signature === gitStatusSignature) return;
    gitStatusSignature = signature;
    renderGitStatus(data);
  } catch (error) {
    if (epoch === gitLoadEpoch) panel.innerHTML = `<div class="workbench-empty">${escapeHtml(error.message || String(error))}</div>`;
  } finally {
    gitLoadInFlight = false;
    if (gitReloadRequested) {
      gitReloadRequested = false;
      loadGitWorkbench(true);
    }
  }
}

async function runGitOperation(operation, body) {
  if (!operation) return;
  try {
    const response = await fetch(`${API_BASE}/api/git/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || IexaI18n.t('git.operationFailed'));
    await loadGitWorkbench(true);
  } catch (error) {
    addError(IexaI18n.t('git.operationFailedPrefix') + (error.message || error));
  }
}

async function runGitMutation(action, target) {
  try {
    const response = await fetch(`${API_BASE}/api/git/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [target] }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || IexaI18n.t('git.operationFailed'));
    await loadGitWorkbench(true);
  } catch (error) {
    addError(IexaI18n.t('git.operationFailedPrefix') + (error.message || error));
  }
}

async function openGitDiff(target, staged) {
  const host = document.getElementById('gitDiffHost');
  if (!host) return;
  host.innerHTML = '<div class="workbench-empty">' + IexaI18n.t('git.loadingDiff') + '</div>';
  try {
    const response = await fetch(`${API_BASE}/api/git/diff?path=${encodeURIComponent(target)}&staged=${staged ? '1' : '0'}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || IexaI18n.t('git.readDiffFailed'));
    const title = `${data.staged ? IexaI18n.t('git.staged') : IexaI18n.t('git.unstaged')} · ${data.path || target}`;
    host.innerHTML = `<div class="git-diff-head"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><button type="button" class="git-diff-close ui-icon-button" aria-label="${IexaI18n.t('git.closeDiff')}">${uiIcon('close')}</button></div><pre class="git-diff"></pre>`;
    const diff = host.querySelector('.git-diff');
    if (diff) diff.textContent = data.content || IexaI18n.t('git.noDiff');
    if (data.truncated && diff) diff.textContent += '\n\n' + IexaI18n.t('git.diffTruncated');
    host.querySelector('.git-diff-close')?.addEventListener('click', () => { host.innerHTML = ''; });
  } catch (error) {
    host.innerHTML = `<div class="workbench-empty">${escapeHtml(error.message || String(error))}</div>`;
  }
}

async function searchWorkspaceText(query) {
  const resultsHost = document.getElementById('workspaceSearchResults');
  if (!resultsHost) return;
  const trimmed = String(query || '').trim();
  const epoch = ++workspaceSearchEpoch;
  if (!projectRoot) {
    resultsHost.innerHTML = '<div class="workbench-empty">' + IexaI18n.t('files.openFirst') + '</div>';
    return;
  }
  if (trimmed.length < 2) {
    resultsHost.innerHTML = '<div class="workbench-empty">' + IexaI18n.t('search.minChars') + '</div>';
    return;
  }
  resultsHost.innerHTML = '<div class="workbench-empty">' + IexaI18n.t('search.searching') + '</div>';
  try {
    const response = await fetch(`${API_BASE}/api/fs/search?q=${encodeURIComponent(trimmed)}&limit=100`);
    const data = await response.json();
    if (epoch !== workspaceSearchEpoch) return;
    if (!response.ok) throw new Error(data.error || IexaI18n.t('search.failed'));
    const results = data.results || [];
    if (!results.length) {
      resultsHost.innerHTML = '<div class="workbench-empty">' + IexaI18n.t('search.noResults') + '</div>';
      return;
    }
    resultsHost.innerHTML = results.map((result) => `<button type="button" class="workspace-search-result" data-path="${escapeHtml(result.path)}" title="${escapeHtml(result.path)}:${result.line}"><span class="workspace-search-path">${escapeHtml(result.path)}:${result.line}:${result.column}</span><span class="workspace-search-preview">${escapeHtml(result.preview)}</span></button>`).join('');
    resultsHost.querySelectorAll('.workspace-search-result').forEach((button) => {
      button.addEventListener('click', async () => {
        const target = button.dataset.path;
        if (!target) return;
        switchWorkbenchView('files');
        await openFilePreview(target);
      });
    });
  } catch (error) {
    if (epoch === workspaceSearchEpoch) resultsHost.innerHTML = `<div class="workbench-empty">${escapeHtml(error.message || String(error))}</div>`;
  }
}

function fileIcon(entry) {
  const name = String(entry.name || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  const icon = (kind, label) => {
    const codeKinds = new Set(['javascript', 'typescript', 'react', 'python', 'html', 'css', 'sass', 'json', 'yaml', 'xml', 'config', 'c', 'cpp', 'java', 'go', 'rust', 'php', 'ruby']);
    const symbol = entry.type === 'dir' ? 'folder' : codeKinds.has(kind) ? 'code'
      : ['shell', 'terminal', 'powershell'].includes(kind) ? 'terminal' : kind === 'archive' ? 'box' : 'file';
    return `<span class="file-type-icon file-type-icon-${kind} ${entry.type === 'dir' ? 'is-folder' : 'is-file'}" role="img" aria-label="${label}" title="${label}"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#ui-${symbol}"/></svg></span>`;
  };

  if (entry.type === 'dir') {
    const folders = {
      '.git': ['git-folder', IexaI18n.t('filetype.git'), '◆'], '.github': ['github-folder', IexaI18n.t('filetype.github'), '◆'],
      'node_modules': ['node-folder', IexaI18n.t('filetype.nodeModules'), '⬡'], 'src': ['source-folder', IexaI18n.t('filetype.source'), '‹›'],
      'dist': ['build-folder', IexaI18n.t('filetype.buildOutput'), '▣'], 'build': ['build-folder', IexaI18n.t('filetype.buildDir'), '▣'],
      'out': ['build-folder', IexaI18n.t('filetype.distDir'), '▣'], 'public': ['assets-folder', IexaI18n.t('filetype.public'), '◈'],
      'assets': ['assets-folder', IexaI18n.t('filetype.assets'), '◈'], 'images': ['assets-folder', IexaI18n.t('filetype.images'), '◈'],
      'workspace': ['workspace-folder', IexaI18n.t('tool.meta.workspace'), '⌘'], 'scripts': ['scripts-folder', IexaI18n.t('filetype.scripts'), '>_'],
      'test': ['test-folder', IexaI18n.t('filetype.tests'), 'T'], 'tests': ['test-folder', IexaI18n.t('filetype.tests'), 'T'],
    };
    const found = folders[name] || ['folder', IexaI18n.t('filetype.folder'), ''];
    return icon(found[0], found[1], found[2]);
  }

  const byName = {
    '.gitignore': ['git', IexaI18n.t('filetype.gitignore'), '◆'], '.gitattributes': ['git', IexaI18n.t('filetype.gitattributes'), '◆'],
    'package.json': ['npm', IexaI18n.t('filetype.npmConfig'), 'NPM'], 'package-lock.json': ['npm', IexaI18n.t('filetype.npmLock'), 'NPM'],
    'tsconfig.json': ['typescript', IexaI18n.t('filetype.tsConfig'), 'TS'], 'readme.md': ['markdown', IexaI18n.t('filetype.markdown'), 'M↓'],
    'license': ['license', IexaI18n.t('filetype.license'), '§'], 'dockerfile': ['docker', IexaI18n.t('filetype.docker'), '▣'],
    '.env': ['env', IexaI18n.t('filetype.env'), 'E'], '.env.local': ['env', IexaI18n.t('filetype.env'), 'E'],
  };
  const byExt = {
    js: ['javascript', 'JavaScript', 'JS'], mjs: ['javascript', 'JavaScript', 'JS'], cjs: ['javascript', 'JavaScript', 'JS'],
    ts: ['typescript', 'TypeScript', 'TS'], tsx: ['react', IexaI18n.t('filetype.tsx'), 'R'], jsx: ['react', IexaI18n.t('filetype.jsx'), 'R'],
    py: ['python', 'Python', 'Py'], json: ['json', 'JSON', '{}'], md: ['markdown', 'Markdown', 'M↓'], mdx: ['markdown', 'Markdown', 'M↓'],
    html: ['html', 'HTML', '5'], htm: ['html', 'HTML', '5'], css: ['css', 'CSS', '#'], scss: ['sass', 'SCSS', 'S'], sass: ['sass', 'Sass', 'S'], less: ['sass', 'Less', 'L'],
    yml: ['yaml', 'YAML', 'Y'], yaml: ['yaml', 'YAML', 'Y'], xml: ['xml', 'XML', 'XML'], toml: ['config', 'TOML', 'CFG'], ini: ['config', 'INI', 'CFG'], conf: ['config', IexaI18n.t('filetype.config'), 'CFG'],
    sh: ['shell', IexaI18n.t('filetype.sh'), '>_'], bash: ['shell', IexaI18n.t('filetype.bash'), '>_'], zsh: ['shell', IexaI18n.t('filetype.zsh'), '>_'], bat: ['terminal', IexaI18n.t('filetype.bat'), '>_'], cmd: ['terminal', IexaI18n.t('filetype.cmd'), '>_'], ps1: ['powershell', IexaI18n.t('filetype.ps1'), 'PS'],
    png: ['image', IexaI18n.t('filetype.png'), '▧'], jpg: ['image', IexaI18n.t('filetype.jpg'), '▧'], jpeg: ['image', IexaI18n.t('filetype.jpeg'), '▧'], gif: ['image', IexaI18n.t('filetype.gif'), '▧'], webp: ['image', IexaI18n.t('filetype.webp'), '▧'], svg: ['image', IexaI18n.t('filetype.svg'), '▧'], ico: ['image', IexaI18n.t('filetype.icon'), '▧'],
    txt: ['text', IexaI18n.t('filetype.text'), '≡'], log: ['log', IexaI18n.t('filetype.log'), '≡'], csv: ['table', IexaI18n.t('filetype.csv'), '▦'], xlsx: ['table', IexaI18n.t('filetype.excel'), '▦'],
    zip: ['archive', IexaI18n.t('filetype.archive'), '▤'], rar: ['archive', IexaI18n.t('filetype.archive'), '▤'], '7z': ['archive', IexaI18n.t('filetype.archive'), '▤'],
    patch: ['diff', IexaI18n.t('filetype.patch'), '±'], diff: ['diff', IexaI18n.t('filetype.diff'), '±'],
    c: ['c', IexaI18n.t('filetype.c'), 'C'], h: ['c', IexaI18n.t('filetype.h'), 'H'], cpp: ['cpp', IexaI18n.t('filetype.cpp'), 'C+'], hpp: ['cpp', IexaI18n.t('filetype.hpp'), 'H+'],
    java: ['java', 'Java', 'J'], go: ['go', 'Go', 'Go'], rs: ['rust', 'Rust', 'R'], php: ['php', 'PHP', 'PHP'], rb: ['ruby', 'Ruby', 'Rb'],
  };
  const found = byName[name] || byExt[ext] || ['file', IexaI18n.t('filetype.file'), ''];
  return icon(found[0], found[1], found[2]);
}

function showFilesEmpty(recent) {
  const list = document.getElementById('filesList');
  const pathEl = document.getElementById('filesPath');
  const crumb = document.getElementById('filesCrumb');
  const title = document.getElementById('filesPanelTitle');
  const refreshBtn = document.getElementById('filesRefreshBtn');
  const closeProj = document.getElementById('filesCloseProjectBtn');
  closeFilePreview();
  if (title) {
    title.textContent = IexaI18n.t('ui.43');
    title.removeAttribute('title');
    title.removeAttribute('aria-label');
  }
  if (pathEl) pathEl.style.display = 'none';
  if (crumb) { crumb.style.display = 'none'; crumb.innerHTML = ''; }
  if (refreshBtn) refreshBtn.style.display = 'none';
  if (closeProj) closeProj.style.display = 'none';
  if (!list) return;

  let recentHtml = '';
  const items = recent || projectRecent || [];
  if (items.length) {
    recentHtml = `<div class="files-recent"><div class="files-recent-label">${IexaI18n.t('files.recent')}</div>` +
      items.map((r) => {
        const p = typeof r === 'string' ? r : r.path;
        const n = typeof r === 'string' ? (r.split(/[/\\]/).pop() || r) : (r.name || r.path);
        return `<button type="button" class="files-recent-item" data-root="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(n)}</button>`;
      }).join('') + `</div>`;
  }

  list.innerHTML = `
    <div class="files-empty-state" id="filesEmptyState">
      <div class="files-empty-icon">${uiIcon('folder')}</div>
      <p>${IexaI18n.t('files.noProject')}</p>
      <p class="files-empty-hint">${IexaI18n.t('files.emptyHint')}</p>
      <button type="button" class="btn-primary btn-sm" id="filesOpenBtnMain">${IexaI18n.t('ui.6')}</button>
      ${recentHtml}
    </div>
  `;
  const mainOpen = document.getElementById('filesOpenBtnMain');
  if (mainOpen) mainOpen.addEventListener('click', openProjectPicker);
  list.querySelectorAll('.files-recent-item').forEach((btn) => {
    btn.addEventListener('click', () => openProjectPath(btn.dataset.root));
  });
}

function renderFilesCrumb(relPath, rootName) {
  const el = document.getElementById('filesCrumb');
  if (!el) return;
  const parts = (relPath === '.' || !relPath) ? [] : relPath.split('/').filter(Boolean);
  // At the project root the title is enough; show navigation only in a child folder.
  if (!parts.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = 'flex';
  let html = `<button type="button" data-path="." aria-label="${IexaI18n.t('files.backToRoot')}">${escapeHtml(rootName || IexaI18n.t('ui.43'))}</button>`;
  let acc = '';
  for (const p of parts) {
    acc = acc ? acc + '/' + p : p;
    html += `<span class="sep">/</span><button type="button" data-path="${escapeHtml(acc)}">${escapeHtml(p)}</button>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => loadFilesList(btn.dataset.path || '.'));
  });
}

async function loadProjectState() {
  try {
    const resp = await fetch(`${API_BASE}/api/project`);
    const data = await resp.json();
    projectRoot = data.root || null;
    projectName = data.name || null;
    projectRecent = data.recent || [];
    if (projectRoot) {
      filesCurrentPath = '.';
      await loadFilesList('.', false);
    } else {
      showFilesEmpty(projectRecent);
    }
    renderSessionList();
  } catch {
    showFilesEmpty([]);
  }
}

async function openProjectPath(rootPath) {
  if (!rootPath) return;
  try {
    const resp = await fetch(`${API_BASE}/api/project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: rootPath }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || IexaI18n.t('files.openFailed'));
    projectRoot = data.root || null;
    projectName = data.name || null;
    projectRecent = data.recent || [];
    gitStatusSignature = '';
    gitLoadEpoch++;
    filesCurrentPath = '.';
    filesLastSig = '';
    closeFilePreview();
    await loadFilesList('.', false);
    const projectSession = sessionsCache
      .filter(session => session.archived !== true && String(session.projectRoot || '').toLowerCase() === String(projectRoot || '').toLowerCase())
      .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || Number(b.updated) - Number(a.updated))[0];
    if (projectSession) await switchSession(projectSession.id);
    else await createSession();
    if (workbenchView === 'git') loadGitWorkbench();
    window.syncHeroWorkspace?.();
  } catch (err) {
    addError(IexaI18n.t('files.openFailedPrefix') + (err.message || err));
  }
}

async function openProjectPicker() {
  // Electron native folder dialog
  if (window.iexaDesktop && typeof window.iexaDesktop.pickFolder === 'function') {
    try {
      const folder = await window.iexaDesktop.pickFolder();
      if (folder) await openProjectPath(folder);
      return;
    } catch (err) {
      console.error(err);
    }
  }
  // Fallback: prompt for path (browser / no preload)
  const p = (await window.IexaDialogs.prompt(IexaI18n.t('files.pathPrompt')));
  if (p && p.trim()) await openProjectPath(p.trim());
}

async function closeProject() {
  try {
    await fetch(`${API_BASE}/api/project/clear`, { method: 'POST' });
  } catch { /* */ }
  projectRoot = null;
  projectName = null;
  filesCurrentPath = '.';
  filesLastSig = '';
  gitStatusSignature = '';
  gitLoadEpoch++;
  switchWorkbenchView('files');
  await loadProjectState();
  const unbound = sessionsCache
    .filter(session => session.archived !== true && !session.projectRoot)
    .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || Number(b.updated) - Number(a.updated))[0];
  if (unbound) await switchSession(unbound.id); else await createSession();
  window.syncHeroWorkspace?.();
}

async function loadFilesList(relPath, silent) {
  const list = document.getElementById('filesList');
  const pathEl = document.getElementById('filesPath');
  const title = document.getElementById('filesPanelTitle');
  const refreshBtn = document.getElementById('filesRefreshBtn');
  const closeProj = document.getElementById('filesCloseProjectBtn');
  if (!list) return;

  if (!projectRoot) {
    showFilesEmpty(projectRecent);
    return;
  }

  const target = relPath == null ? filesCurrentPath : relPath;
  try {
    if (!silent) list.innerHTML = '<div class="files-empty">' + IexaI18n.t('files.loading') + '</div>';
    const resp = await fetch(`${API_BASE}/api/fs/list?path=${encodeURIComponent(target)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || IexaI18n.t('files.loadFailed'));

    if (data.empty || !data.root) {
      projectRoot = null;
      showFilesEmpty(projectRecent);
      return;
    }

    projectRoot = data.root;
    projectName = data.name || projectName;
    filesCurrentPath = data.path || '.';

    if (title) {
      title.textContent = projectName || IexaI18n.t('ui.43');
      title.title = data.root || projectRoot || projectName || IexaI18n.t('ui.43');
      title.setAttribute('aria-label', `${projectName || IexaI18n.t('ui.43')}：${data.root || projectRoot || ''}`);
    }
    // The project name already identifies the root. Keep the absolute path available
    // as a tooltip and only render breadcrumbs after entering a child directory.
    if (pathEl) {
      pathEl.style.display = 'none';
      pathEl.textContent = data.root || projectRoot || '';
      pathEl.title = data.root || projectRoot || '';
    }
    if (refreshBtn) refreshBtn.style.display = 'flex';
    if (closeProj) closeProj.style.display = 'flex';
    renderFilesCrumb(filesCurrentPath, projectName);

    const entries = data.entries || [];
    const sig = entries.map((e) => e.name + e.type + e.size + e.mtime).join('|') + '@' + filesCurrentPath + '@' + projectRoot;
    if (silent && sig === filesLastSig) return;
    filesLastSig = sig;

    if (entries.length === 0) {
      list.innerHTML = '<div class="files-empty">' + IexaI18n.t('files.emptyDir') + '</div>';
      return;
    }

    const showUp = filesCurrentPath && filesCurrentPath !== '.';
    let html = '';
    if (showUp) {
      const parent = filesCurrentPath.split('/').slice(0, -1).join('/') || '.';
      html += `<button type="button" class="files-item" data-nav="${escapeHtml(parent)}">
        <span class="files-item-icon">${uiIcon('arrow-up')}</span>
        <span class="files-item-name">..</span>
      </button>`;
    }
    html += entries.map((e) => `
      <button type="button" class="files-item${filesSelectedPath === e.path ? ' active' : ''}"
        data-type="${e.type}" data-path="${escapeHtml(e.path)}" title="${escapeHtml(e.path)}">
        <span class="files-item-icon">${fileIcon(e)}</span>
        <span class="files-item-name">${escapeHtml(e.name)}</span>
        <span class="files-item-meta">${e.type === 'dir' ? '' : formatFileSize(e.size || 0)}</span>
      </button>
    `).join('');
    list.innerHTML = html;

    list.querySelectorAll('.files-item').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.nav != null) {
          loadFilesList(btn.dataset.nav);
          return;
        }
        const p = btn.dataset.path;
        const t = btn.dataset.type;
        if (t === 'dir') {
          loadFilesList(p);
        } else {
          await openFilePreview(p);
          list.querySelectorAll('.files-item').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
        }
      });
    });
  } catch (err) {
    if (!silent) list.innerHTML = `<div class="files-empty">${IexaI18n.t('files.loadFailedPrefix')}${escapeHtml(err.message || String(err))}</div>`;
  }
}

async function openFilePreview(relPath) {
  if (isHtmlFilePath(relPath) && openHtmlPreview(relPath)) return;
  const box = document.getElementById('filesPreview');
  const nameEl = document.getElementById('filesPreviewName');
  const bodyEl = document.getElementById('filesPreviewBody');
  if (!box || !bodyEl || !projectRoot) return;
  try {
    filesSelectedPath = relPath;
    const ext = (relPath.split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
      box.dataset.open = 'true';
      box.style.display = 'flex';
      if (nameEl) nameEl.textContent = relPath.split('/').pop() || relPath;
      bodyEl.innerHTML = `<img class="files-preview-image" src="${API_BASE}/api/fs/raw?path=${encodeURIComponent(relPath)}" alt="${escapeHtml(relPath)}">`;
      return;
    }
    const resp = await fetch(`${API_BASE}/api/fs/read?path=${encodeURIComponent(relPath)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || IexaI18n.t('files.readFailed'));
    box.dataset.open = 'true';
    box.style.display = 'flex';
    if (nameEl) nameEl.textContent = data.name || relPath;
    bodyEl.textContent = data.content || '';
  } catch (err) {
    box.dataset.open = 'true';
    box.style.display = 'flex';
    if (nameEl) nameEl.textContent = relPath;
    bodyEl.textContent = IexaI18n.t('files.previewFailedPrefix') + (err.message || err);
  }
}

function closeFilePreview() {
  const box = document.getElementById('filesPreview');
  if (box) { box.dataset.open = 'false'; box.style.display = 'none'; }
  filesSelectedPath = '';
  document.querySelectorAll('.files-item.active').forEach((b) => b.classList.remove('active'));
}

function initFilesPanel() {
  installPluginWorkspaceBridge();
  document.querySelectorAll('.workbench-tab').forEach((button) => {
    button.addEventListener('click', () => switchWorkbenchView(button.dataset.workbenchView));
  });
  const searchInput = document.getElementById('workspaceSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (workspaceSearchTimer) clearTimeout(workspaceSearchTimer);
      workspaceSearchTimer = setTimeout(() => searchWorkspaceText(searchInput.value), 220);
    });
  }
  const openBtn = document.getElementById('filesOpenBtn');
  if (openBtn) openBtn.addEventListener('click', openProjectPicker);
  const refreshBtn = document.getElementById('filesRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    if (projectRoot) loadFilesList(filesCurrentPath);
  });
  const closeProj = document.getElementById('filesCloseProjectBtn');
  if (closeProj) closeProj.addEventListener('click', closeProject);
  const closeBtn = document.getElementById('filesPreviewClose');
  if (closeBtn) closeBtn.addEventListener('click', closeFilePreview);

  // Context menu: right-click on files list items
  const filesList = document.getElementById('filesList');
  const contextMenu = document.getElementById('filesContextMenu');
  let contextTarget = null;

  if (filesList) {
    filesList.addEventListener('contextmenu', (e) => {
      const btn = e.target.closest('.files-item');
      if (!btn || btn.dataset.nav != null) return; // ignore ".." button
      e.preventDefault();
      contextTarget = btn;
      contextMenu.style.display = 'flex';
      contextMenu.style.left = e.clientX + 'px';
      contextMenu.style.top = e.clientY + 'px';
    });
  }

  if (contextMenu) {
    contextMenu.addEventListener('click', async (e) => {
      const item = e.target.closest('.files-context-item');
      if (!item || !contextTarget) return;
      contextMenu.style.display = 'none';
      const action = item.dataset.action;
      const path = contextTarget.dataset.path;
      const name = contextTarget.querySelector('.files-item-name')?.textContent || '';
      const type = contextTarget.dataset.type;

      if (action === 'delete') {
        const label = type === 'dir' ? IexaI18n.t('files.dir') : IexaI18n.t('filetype.file');
        if (!(await window.IexaDialogs.confirm(IexaI18n.t('files.confirmDelete', { label, name })))) return;
        try {
          const resp = await fetch(`${API_BASE}/api/fs/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || IexaI18n.t('files.deleteFailed'));
          loadFilesList(filesCurrentPath);
        } catch (err) {
          (await window.IexaDialogs.alert(IexaI18n.t('files.deleteFailedPrefix') + (err.message || err)));
        }
      } else if (action === 'copy') {
        try {
          await navigator.clipboard.writeText(path);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = path;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
      } else if (action === 'copy-path') {
        const fullPath = projectRoot ? projectRoot.replace(/\\/g, '/') + '/' + path : path;
        try {
          await navigator.clipboard.writeText(fullPath);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = fullPath;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
      }
      contextTarget = null;
    });

    // Close menu on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.files-context-menu')) {
        contextMenu.style.display = 'none';
        contextTarget = null;
      }
    });
  }

  if (filesPollTimer) clearInterval(filesPollTimer);
  filesPollTimer = setInterval(() => {
    if (projectRoot) loadFilesList(filesCurrentPath, true);
    if (projectRoot && workbenchView === 'git') loadGitWorkbench();
  }, 4000);
}

function refreshFilesPanelSoft() {
  if (projectRoot) loadFilesList(filesCurrentPath, true).catch(() => {});
}

