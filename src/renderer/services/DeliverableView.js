// Artifacts and deliverables — split out of app.js.
// Artifact previews, todo plan, deliverable cards and file-change summaries.
//
// Classic script: top-level declarations join the same global scope as
// app.js, so callers keep working unchanged. Keep this file free of load-time
// side effects — it evaluates before app.js and before the DOM is ready.

function renderToolArtifactsAfterStep(stepBlock, artifacts) {
  if (!stepBlock || !Array.isArray(artifacts) || artifacts.length === 0) return;
  let card = stepBlock.nextElementSibling;
  if (!card || !card.classList.contains('tool-artifacts') || card.dataset.toolMediaFor !== stepBlock.dataset.toolId) {
    card = document.createElement('div');
    card.className = 'tool-artifacts tool-artifacts-streamed';
    card.dataset.toolMediaFor = stepBlock.dataset.toolId || '';
    stepBlock.after(card);
  }
  renderToolArtifacts(card, artifacts);
}

function renderToolArtifacts(host, artifacts) {
  if (!host || !Array.isArray(artifacts)) return;
  let card = host.classList && host.classList.contains('tool-artifacts')
    ? host
    : host.querySelector('.tool-artifacts');
  if (!card) {
    card = document.createElement('div');
    card.className = 'tool-artifacts';
    const usage = host.querySelector('.message-usage');
    if (usage) host.insertBefore(card, usage); else host.appendChild(card);
  }
  for (const artifact of artifacts) {
    if (!artifact || !artifact.path) continue;
    const rel = String(artifact.path).replace(/\\/g, '/').replace(/^\.\//, '');
    const src = artifact.url || `${API_BASE}/api/fs/raw?path=${encodeURIComponent(rel)}`;
    if (Array.from(card.children).some((child) => child.dataset && child.dataset.artifactKey === src)) continue;
    if (artifact.kind === 'image' || String(artifact.mimeType || '').startsWith('image/')) {
      const button = document.createElement('div');
      button.className = 'tool-artifact-image';
      button.dataset.artifactKey = src;
      button.title = '点击查看生成的图片';
      button.innerHTML = `<img src="${escapeHtml(src)}" alt="${escapeHtml(rel)}"><span class="tool-artifact-caption"><span class="tool-artifact-name">${escapeHtml(rel)}</span><span class="tool-artifact-actions"><a class="tool-artifact-action" href="${escapeHtml(src)}" download title="保存图片" aria-label="保存图片" data-ui-action="stop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 20h14"/></svg></a><button type="button" class="tool-artifact-action tool-artifact-copy" title="复制图片" aria-label="复制图片"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></svg></button></span></span>`;
      button.addEventListener('click', (event) => {
        if (event.target.closest('.tool-artifact-actions')) return;
        openImagePreview(src, rel, button.querySelector('img'));
      });
      // A card whose bytes vanished must not stay behind as an empty frame.
      const image = button.querySelector('img');
      image.addEventListener('error', () => {
        button.remove();
        if (card.children.length === 0) card.remove();
      });
      button.querySelector('.tool-artifact-copy').addEventListener('click', (event) => {
        event.stopPropagation();
        copyArtifactImage(src, event.currentTarget);
      });
      card.appendChild(button);
    } else if (artifact.kind === 'video' || String(artifact.mimeType || '').startsWith('video/')) {
      const media = document.createElement('div');
      media.className = 'tool-artifact-media tool-artifact-video';
      media.dataset.artifactKey = src;
      media.innerHTML = `<video controls preload="metadata" playsinline src="${escapeHtml(src)}" aria-label="${escapeHtml(rel)}"></video><span class="tool-artifact-caption"><span class="tool-artifact-name">${escapeHtml(rel)}</span><span class="tool-artifact-actions"><a class="tool-artifact-action" href="${escapeHtml(src)}" download title="保存视频" aria-label="保存视频" data-ui-action="stop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 20h14"/></svg></a></span></span>`;
      media.querySelector('video').addEventListener('dblclick', () => window.open(src, '_blank', 'noopener,noreferrer'));
      card.appendChild(media);
    } else if (artifact.kind === 'audio' || String(artifact.mimeType || '').startsWith('audio/')) {
      const media = document.createElement('div');
      media.className = 'tool-artifact-media tool-artifact-audio';
      media.dataset.artifactKey = src;
      media.innerHTML = `<audio controls preload="metadata" src="${escapeHtml(src)}" aria-label="${escapeHtml(rel)}"></audio><span class="tool-artifact-caption"><span class="tool-artifact-name">${escapeHtml(rel)}</span><span class="tool-artifact-actions"><a class="tool-artifact-action" href="${escapeHtml(src)}" download title="保存音频" aria-label="保存音频" data-ui-action="stop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 20h14"/></svg></a></span></span>`;
      card.appendChild(media);
    } else {
      const link = document.createElement('a');
      link.className = 'tool-artifact-file';
      link.dataset.artifactKey = src;
      link.href = src;
      link.textContent = rel;
      const htmlTarget = (isHtmlFilePath(rel) || String(artifact.mimeType || '').toLowerCase() === 'text/html')
        ? resolveHtmlPreviewTarget(artifact.path)
        : null;
      if (htmlTarget) {
        link.classList.add('is-html-preview');
        link.title = '在 IEXA 中预览 HTML 效果';
        link.addEventListener('click', (event) => {
          event.preventDefault();
          openHtmlPreview(htmlTarget);
        });
      } else {
        link.target = '_blank';
        link.rel = 'noreferrer';
      }
      card.appendChild(link);
    }
  }
  if (card.children.length && card !== host && card.parentElement !== host) host.appendChild(card);
}

async function copyArtifactImage(src, button) {
  try {
    const response = await fetch(src);
    const blob = await response.blob();
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    } else {
      throw new Error('clipboard image unsupported');
    }
    button.classList.add('is-copied');
    setTimeout(() => button.classList.remove('is-copied'), 1200);
  } catch (error) {
    console.warn('copy artifact image failed', error);
    (await window.IexaDialogs.alert('当前系统不支持直接复制图片，请使用保存按钮。'));
  }
}

/** Keep every valid row: a plan may legitimately repeat a line. */
function normalizeTodoItems(todos) {
  if (!Array.isArray(todos)) return [];
  return todos.slice(0, 24).map((item) => {
    const status = String(item?.status || '');
    return {
      content: String(item?.content || '').trim(),
      status: status === 'completed' || status === 'in_progress' ? status : 'pending',
    };
  }).filter((item) => item.content);
}

let todoPlanSeed = 0;

function setTodoPlanCollapsed(panel, collapsed) {
  panel.classList.toggle('is-collapsed', collapsed);
  const head = panel.querySelector('.todo-plan-head');
  if (!head) return;
  head.setAttribute('aria-expanded', String(!collapsed));
  head.title = collapsed ? '展开任务计划' : '收起任务计划';
}

function buildTodoPlanPanel() {
  const panel = document.createElement('section');
  panel.className = 'todo-plan';
  panel.dataset.planId = 'todo-plan-' + (++todoPlanSeed);
  panel.innerHTML =
    '<button type="button" class="todo-plan-head" aria-expanded="true" aria-controls="' + panel.dataset.planId + '-items" title="收起任务计划">' +
      '<span class="todo-plan-title">任务计划</span>' +
      '<span class="todo-plan-rail" aria-hidden="true"></span>' +
      '<span class="todo-plan-count"></span>' +
      `<span class="todo-plan-chevron" aria-hidden="true">${uiIcon('chevron-right')}</span>` +
    '</button>' +
    `<div class="todo-plan-body" id="${panel.dataset.planId}-items"><ol class="todo-plan-items" role="list"></ol></div>` +
    '<span class="todo-plan-sr" role="status" aria-live="polite"></span>';
  panel.querySelector('.todo-plan-head').addEventListener('click', () => {
    setTodoPlanCollapsed(panel, !panel.classList.contains('is-collapsed'));
  });
  return panel;
}

function buildTodoPlanRow() {
  const row = document.createElement('li');
  row.className = 'todo-plan-item is-pending';
  row.innerHTML = '<span class="todo-plan-marker"></span><span class="todo-plan-text"></span>';
  return row;
}

/** Repaint one row in place: rewriting the list would restart every spinner. */
function paintTodoPlanRow(row, item) {
  const changed = row.dataset.status !== item.status;
  row.className = 'todo-plan-item is-' + item.status;
  row.dataset.status = item.status;
  const marker = row.querySelector('.todo-plan-marker');
  const kind = item.status === 'completed' ? 'check' : item.status === 'in_progress' ? 'spinner' : 'dot';
  if (marker.dataset.kind !== kind) {
    marker.dataset.kind = kind;
    marker.innerHTML = kind === 'check'
      ? uiIcon('check')
      : `<i class="todo-plan-${kind}" aria-hidden="true"></i>`;
  }
  const text = row.querySelector('.todo-plan-text');
  if (text.textContent !== item.content) text.textContent = item.content;
  text.title = item.content;
  // A completed row earns one settling beat, then stays quiet.
  if (changed && item.status === 'completed') {
    row.classList.add('is-settling');
    setTimeout(() => row.classList.remove('is-settling'), 640);
  }
}

function paintTodoPlanSegment(segment, status) {
  const previous = segment.dataset.status;
  segment.dataset.status = status;
  segment.className = status === 'completed' ? 'is-done' : status === 'in_progress' ? 'is-active' : '';
  if (previous && previous !== 'completed' && status === 'completed') {
    segment.classList.add('is-new');
    setTimeout(() => segment.classList.remove('is-new'), 460);
  }
}

function renderTodoPlan(messageEl, todos, options) {
  const items = normalizeTodoItems(todos);
  if (!messageEl || !items.length) return;
  let panel = messageEl.querySelector('.todo-plan');
  if (!panel) {
    panel = buildTodoPlanPanel();
    const host = messageEl.querySelector('.tool-steps');
    const answer = messageEl.querySelector('.message-content.message-answer');
    if (answer) answer.before(panel);
    else if (host) host.after(panel);
    else messageEl.appendChild(panel);
  }

  const list = panel.querySelector('.todo-plan-items');
  if (list.children.length !== items.length) {
    list.replaceChildren(...items.map(() => buildTodoPlanRow()));
  }
  const rows = Array.from(list.children);
  items.forEach((item, index) => paintTodoPlanRow(rows[index], item));

  const done = items.filter((item) => item.status === 'completed').length;
  const active = items.find((item) => item.status === 'in_progress') || null;

  const rail = panel.querySelector('.todo-plan-rail');
  if (rail.children.length !== items.length) {
    rail.replaceChildren(...items.map(() => document.createElement('i')));
  }
  Array.from(rail.children).forEach((segment, index) => paintTodoPlanSegment(segment, items[index].status));

  const count = panel.querySelector('.todo-plan-count');
  const countText = done + '/' + items.length;
  if (count.textContent !== countText) count.textContent = countText;
  count.classList.toggle('is-complete', done === items.length);

  // Announce state changes without turning every delta into speech.
  const live = panel.querySelector('.todo-plan-sr');
  const announcement = done === items.length
    ? `任务计划：${items.length} 项全部完成`
    : `任务计划：${done}/${items.length} 已完成${active ? `，正在进行：${active.content}` : ''}`;
  if (live.textContent !== announcement) live.textContent = announcement;

  // A finished plan folded away on restore keeps history compact; a live plan
  // stays open so the user watches it advance.
  if (!panel.dataset.seeded) {
    panel.dataset.seeded = '1';
    if (options && options.restored && done === items.length) setTodoPlanCollapsed(panel, true);
  }
}

function latestTodoPlanFromCalls(calls) {
  let plan = null;
  for (const call of calls || []) {
    if (call?.name !== 'todo_write' || call?.result?.success === false) continue;
    const todos = call?.result?.todos || call?.args?.todos;
    if (normalizeTodoItems(todos).length) plan = todos;
  }
  return plan;
}

function renderDeliverables(messageEl, files) {
  if (!messageEl || !Array.isArray(files)) return;
  const unique = window.IexaFileChanges.group(files);
  let panel = messageEl.querySelector('.turn-deliverables');
  if (!unique.length) { panel?.remove(); return; }
  if (!panel) {
    panel = document.createElement('section');
    panel.className = 'turn-deliverables';
    const footer = assistantFooterAnchor(messageEl);
    if (footer) messageEl.insertBefore(panel, footer); else messageEl.appendChild(panel);
  }
  const sessionId = messageEl.dataset.liveSessionId || currentSessionId;
  const turnId = messageEl.dataset.transcriptTurnId;
  panel.replaceChildren();
  panel.setAttribute('aria-label', '本轮文件修改');
  const totals = unique.reduce((sum, file) => ({added: sum.added + (Number(file.added) || 0), removed: sum.removed + (Number(file.removed) || 0)}), {added:0, removed:0});
  const counts = file => `<span class="diff-add">+${Number(file.added) || 0}</span><span class="diff-del">−${Number(file.removed) || 0}</span>`;
  const heading = document.createElement('button');
  heading.type = 'button';
  heading.className = 'turn-deliverables-heading';
  heading.setAttribute('aria-expanded', 'true');
  const bodyId = `turn-deliverables-${Math.random().toString(36).slice(2, 9)}`;
  heading.setAttribute('aria-controls', bodyId);
  heading.title = '展开或收起文件列表';
  heading.innerHTML = `${uiIcon('file')}<strong>已编辑 ${unique.length} 个文件</strong><span class="turn-change-counts">${counts(totals)}</span><span class="turn-deliverables-chevron" aria-hidden="true"></span>`;
  const filesEl = document.createElement('div');
  filesEl.className = 'turn-deliverable-files';
  for (const file of unique) {
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'turn-change-file'; row.title = file.path;
    row.innerHTML = `${uiIcon('file')}<span class="turn-deliverable-name">${escapeHtml(file.path)}</span><span class="turn-change-counts">${counts(file)}</span>`;
    row.setAttribute('aria-label', `审查文件：${file.path}`);
    row.addEventListener('click', () => { setCollapsed(false); showReview(file); });
    filesEl.appendChild(row);
  }
  const actions = document.createElement('div'); actions.className = 'turn-change-actions';
  const status = document.createElement('span'); status.className = 'turn-change-status'; status.setAttribute('role','status');
  const undo = document.createElement('button'); undo.type = 'button'; undo.className = 'turn-change-undo'; undo.textContent = '撤销';
  const review = document.createElement('button'); review.type = 'button'; review.className = 'turn-change-review'; review.textContent = '审查'; review.setAttribute('aria-expanded','false');
  const details = document.createElement('div'); details.className = 'turn-change-details'; details.hidden = true;
  const undone = new Set(messageEl._fileUndoPaths || []);
  const allUndone = unique.every(file => undone.has(file.absolutePath));
  const unavailable = !turnId ? '旧记录缺少本轮标识' : files.some(file => !(file.rollback || file.hasRollback)) ? (files.find(file=>file.undoUnavailable)?.undoUnavailable || '旧记录没有完整撤销快照') : '';
  undo.disabled = allUndone || !!unavailable;
  undo.title = allUndone ? '本轮修改已撤销' : unavailable || '恢复本轮修改前的文件；后续修改会触发冲突保护';
  if (allUndone) { undo.textContent = '已撤销'; status.textContent = '文件已恢复'; }
  else if (unavailable) status.textContent = unavailable;
  else if (unique.some(file => file.previewTruncated)) status.textContent = '大文件显示截取预览；统计为各次修改累计';
  else if (unique.some(file => file.exact === false)) status.textContent = '大范围差异按块替换统计';
  function showReview(selected) {
    details.replaceChildren();
    for (const file of selected ? [selected] : unique) {
      const section = document.createElement('section');
      const title = document.createElement('strong'); title.textContent = file.path; section.appendChild(title);
      if (typeof file.before !== 'string' || typeof file.after !== 'string') {
        const note = document.createElement('p'); note.textContent = '此旧记录未保存差异内容'; section.appendChild(note);
      } else {
        const diff = window.IexaFileChanges.diff(file.before, file.after);
        const visible = new Set();
        diff.ops.forEach((op,i)=>{if(op.type!=='context')for(let j=Math.max(0,i-3);j<=Math.min(diff.ops.length-1,i+3);j++)visible.add(j);});
        const lines = []; let previous = -1;
        for (const i of visible) { if(i>previous+1)lines.push({type:'context',text:'…'}); lines.push(diff.ops[i]); previous=i; }
        if (!lines.length) { const note=document.createElement('p');note.textContent='内容无净变化';section.appendChild(note); }
        else if (lines.length > 2000) { const pre=document.createElement('pre');section.appendChild(pre);setPagedText(pre,lines.map(op=>(op.type==='added'?'+':op.type==='removed'?'-':' ')+op.text).join('\n')); }
        else for (const op of lines) { const line=document.createElement('div');line.className=`diff-line diff-${op.type}`;line.textContent=(op.type==='added'?'+':op.type==='removed'?'−':' ')+op.text;section.appendChild(line); }
        if (file.previewTruncated) { const note=document.createElement('p');note.textContent='差异预览已截取，完整文件请在项目中打开。';section.appendChild(note); }
      }
      details.appendChild(section);
    }
    details.hidden = false; setReviewOpen(true);
  }
  review.addEventListener('click', () => {
    if (panel.classList.contains('is-collapsed')) { setCollapsed(false); showReview(); return; }
    if (details.hidden) showReview(); else setReviewOpen(false);
  });
  undo.addEventListener('click', async () => {
    if (sessionRuntimes.get(sessionId)?.isProcessing) {status.textContent='请等待该会话任务结束后撤销';return;}
    if (!(await window.IexaDialogs.confirm('撤销本轮文件修改？新建文件将删除，已有文件将恢复到本轮修改前。'))) return;
    undo.disabled = true; status.textContent = '正在校验并撤销…';
    try {
      const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/undo`, {method:'POST'});
      const data = await response.json();
      if (data.restoredPaths) messageEl._fileUndoPaths = data.restoredPaths;
      if (!response.ok) throw new Error(data.error || '撤销未完成');
      undo.textContent = '已撤销'; status.textContent = '文件已恢复'; undo.title = '本轮修改已撤销';
    } catch (error) { status.textContent = error.message; undo.disabled=false; }
  });
  const body = document.createElement('div');
  body.className = 'turn-deliverables-body';
  body.id = bodyId;
  body.append(filesEl, details);

  function setReviewOpen(open) {
    details.hidden = !open;
    review.setAttribute('aria-expanded', String(open));
    review.textContent = open ? '收起' : '审查';
  }
  function setCollapsed(collapsed) {
    panel.classList.toggle('is-collapsed', collapsed);
    heading.setAttribute('aria-expanded', String(!collapsed));
    messageEl._deliverablesCollapsed = collapsed;
    if (collapsed) setReviewOpen(false);
  }
  heading.addEventListener('click', () => setCollapsed(!panel.classList.contains('is-collapsed')));

  actions.append(status, undo, review);
  panel.append(heading, body, actions);
  setCollapsed(messageEl._deliverablesCollapsed === true);
}

async function openDeliverablePreview(path, absolutePath) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (isHtmlFilePath(absolutePath || normalized) && openHtmlPreview(absolutePath || normalized)) return;
  // The project file preview is safer and keeps the user in IEXA when this
  // deliverable belongs to the currently opened project.
  if (projectRoot && normalized && !/^(?:[A-Za-z]:\/|\/)/.test(normalized)) {
    await openFilePreview(normalized);
    return;
  }
  if (absolutePath && window.iexaDesktop && typeof window.iexaDesktop.openPath === 'function') {
    await window.iexaDesktop.openPath(absolutePath);
  }
}

function collectLiveDeliverables() {
  return Object.values(currentToolBlocks || {})
    .filter((info) => info?.fileChange && info?.success)
    .map((info) => info.fileChange);
}

function renderFileChange(host, change) {
  let card = host.querySelector('.file-change-card');
  if (card) card.remove();
  card = document.createElement('div');
  card.className = 'file-change-card';
  // Long sessions can hold dozens of edit cards; restoring or streaming a task
  // must never block on thousands of diff rows. Build the rows lazily on first
  // expand and cap each side — the full change stays reviewable in the file.
  const MAX_DIFF_LINES = 240;
  const diff = document.createElement('div');
  diff.className = 'file-change-diff';
  diff.hidden = true;
  diff.dataset.built = '0';
  const buildDiff = () => {
    if (diff.dataset.built === '1') return;
    diff.dataset.built = '1';
    const before = String(change.before || '').split(/\r?\n/);
    const after = String(change.after || '').split(/\r?\n/);
    const oldLines = before.slice(0, MAX_DIFF_LINES).map((line) => `<div class="diff-line diff-removed"><span>-</span>${escapeHtml(line)}</div>`).join('');
    const newLines = after.slice(0, MAX_DIFF_LINES).map((line) => `<div class="diff-line diff-added"><span>+</span>${escapeHtml(line)}</div>`).join('');
    const truncated = before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES;
    const note = truncated ? `<div class="diff-line diff-note">… 仅显示前后各前 ${MAX_DIFF_LINES} 行，完整差异请打开文件查看</div>` : '';
    diff.innerHTML = oldLines + newLines + note;
  };
  card.innerHTML = `<div class="file-change-header"><button type="button" class="file-change-path" title="打开文件">已编辑 ${escapeHtml(change.path)}</button><b class="diff-add">+${Number(change.added) || 0}</b><b class="diff-del">-${Number(change.removed) || 0}</b><button type="button" class="file-change-review">审查</button></div>`;
  card.appendChild(diff);
  card.querySelector('.file-change-review').addEventListener('click', (e) => {
    diff.hidden = !diff.hidden;
    if (!diff.hidden) buildDiff();
    e.currentTarget.textContent = diff.hidden ? '审查' : '收起';
  });
  card.querySelector('.file-change-path').addEventListener('click', () => {
    if (typeof openFilePreview === 'function') openFilePreview(change.path);
  });
  host.appendChild(card);
}

function normalizeRenderedAssets(contentEl) {
  if (!contentEl) return;
  contentEl.querySelectorAll('img').forEach((img) => {
    const raw = img.getAttribute('src') || '';
    if (/^(?:workspace\/|\.\/|\.\.\/|[A-Za-z]:[\\/])/.test(raw) && !raw.startsWith('data:')) {
      // When a project is open, workspace/ is a real child of the project root.
      // Without a project, the API root is workspace itself.
      const rel = (projectRoot ? raw : raw.replace(/^workspace[\\/]/i, ''))
        .replace(/^[.][\\/]/, '').replace(/\\/g, '/');
      img.src = `${API_BASE}/api/fs/raw?path=${encodeURIComponent(rel)}`;
      img.addEventListener('click', () => openImagePreview(img.src, img.alt || '图片', img));
      img.style.cursor = 'zoom-in';
    }
  });
  contentEl.querySelectorAll('a').forEach((link) => {
    if (link.dataset.iexaHtmlPreview) return;
    const rawHref = link.getAttribute('href') || '';
    const target = resolveHtmlPreviewTarget(rawHref);
    if (!target) return;
    link.dataset.iexaHtmlPreview = target.displayPath || target.path;
    link.classList.add('markdown-html-preview-link');
    link.removeAttribute('target');
    link.removeAttribute('rel');
    link.title = '在 IEXA 中预览 HTML 效果';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openHtmlPreview(target);
    });
  });
}
