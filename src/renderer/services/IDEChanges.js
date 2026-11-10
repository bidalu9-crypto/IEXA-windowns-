// Git state and AI review are independent. The host owns workspace-scoped IPC
// and the existing editor models; this module never stages or commits files.
(function (root) {
  'use strict';
  const words = {
    changes: ['更改', 'Changes', '変更'], git: ['Git 更改', 'Git changes', 'Git 変更'], ai: ['AI 改动审阅', 'Review AI edits', 'AI 変更レビュー'],
    accept: ['接受此块', 'Accept block', 'この変更を承認'], reject: ['拒绝此块', 'Reject block', 'この変更を拒否'],
    acceptAll: ['接受全部', 'Accept all', 'すべて承認'], rejectAll: ['拒绝全部', 'Reject all', 'すべて拒否'],
    previous: ['上一处改动', 'Previous change', '前の変更'], next: ['下一处改动', 'Next change', '次の変更'], close: ['关闭差异视图', 'Close diff', '差分を閉じる'],
    empty: ['工作区没有 Git 更改', 'No Git changes', 'Git 変更はありません'], notRepo: ['此项目不是 Git 仓库', 'This project is not a Git repository', 'Git リポジトリではありません'], noGit: ['Git 暂不可用', 'Git is unavailable', 'Git を利用できません'],
    dirty: ['请先保存或重载当前文件，再审阅 AI 改动；未保存的编辑已保留。', 'Save or reload this file before reviewing AI edits. Unsaved edits are preserved.', 'AI 変更をレビューする前に保存または再読み込みしてください。未保存の編集は保持されています。'],
    stale: ['文件已再次更改；本次审阅已暂停，请查看最新差异。', 'The file changed again. Review is paused; inspect the latest diff.', 'ファイルが再度変更されました。最新の差分を確認してください。'],
    accepted: ['已接受', 'Accepted', '承認済み'], rejected: ['已拒绝', 'Rejected', '拒否済み'], pending: ['待审阅', 'Pending review', 'レビュー待ち'],
    binary: ['二进制文件，仅显示 Git 状态。', 'Binary file; Git status only.', 'バイナリファイルのため Git 状態のみ表示します。'],
    protection: ['此文件的新增或删除需要主进程原子审阅接口。当前文件和原始改动已保留。', 'An atomic host review operation is required for creation or deletion. Existing changes are preserved.', '追加または削除にはホストのアトミック操作が必要です。既存の変更は保持されています。'],
    hint: ['接受只确认此处 AI 改动；Git 暂存和提交需另行操作。拒绝只还原对应 AI 改动。', 'Accept confirms this AI edit. Git staging and commits are separate. Reject restores only this AI edit.', '承認は AI 変更の確認です。Git ステージ・コミットは別操作です。拒否はこの AI 変更だけを戻します。'],
    noReview: ['此文件没有待审阅的 AI 改动', 'No pending AI edits in this file', 'レビュー待ちの AI 変更はありません'], staged: ['已暂存', 'Staged', 'ステージ済み'], unstaged: ['未暂存', 'Unstaged', '未ステージ'], conflict: ['合并冲突', 'Merge conflict', 'マージ競合'],
    modified: ['已修改', 'Modified', '変更'], added: ['新增', 'Added', '追加'], deleted: ['已删除', 'Deleted', '削除'], renamed: ['重命名', 'Renamed', '名前変更'], untracked: ['未跟踪', 'Untracked', '未追跡'],
    head: ['与 HEAD 比较', 'Compare with HEAD', 'HEAD と比較'], index: ['与暂存区比较', 'Compare with index', 'インデックスと比較'],
  };
  const lines = value => String(value ?? '').match(/[^\n]*\n|[^\n]+$/g) || [];
  function diffHunks(before, after) {
    const a = lines(before), b = lines(after);
    let prefix = 0, suffix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
    const left = a.slice(prefix, a.length - suffix), right = b.slice(prefix, b.length - suffix);
    if (!left.length && !right.length) return [];
    const max = left.length + right.length, trace = [], v = new Map([[1, 0]]);
    let ops, work = 0;
    outer: for (let d = 0; d <= Math.min(max, 1024); d++) {
      trace.push(new Map(v));
      for (let k = -d; k <= d; k += 2) {
        if (++work > 1000000) break outer;
        let x = k === -d || k !== d && (v.get(k - 1) ?? -Infinity) < (v.get(k + 1) ?? -Infinity) ? v.get(k + 1) || 0 : (v.get(k - 1) || 0) + 1;
        let y = x - k;
        while (x < left.length && y < right.length && left[x] === right[y]) { x++; y++; }
        v.set(k, x);
        if (x >= left.length && y >= right.length) {
          ops = [];
          for (let depth = trace.length - 1; depth >= 0; depth--) {
            const previous = trace[depth], diagonal = x - y;
            const prevK = diagonal === -depth || diagonal !== depth && (previous.get(diagonal - 1) ?? -Infinity) < (previous.get(diagonal + 1) ?? -Infinity) ? diagonal + 1 : diagonal - 1;
            const prevX = previous.get(prevK) || 0, prevY = prevX - prevK;
            while (x > prevX && y > prevY) { ops.push({ type: '=', text: left[--x] }); y--; }
            if (!depth) break;
            if (x === prevX) ops.push({ type: '+', text: right[--y] });
            else ops.push({ type: '-', text: left[--x] });
          }
          ops.reverse(); break outer;
        }
      }
    }
    // Bound pathological rewrites instead of doing unbounded quadratic work.
    if (!ops) ops = [...left.map(text => ({ type: '-', text })), ...right.map(text => ({ type: '+', text }))];
    const hunks = []; let oldLine = prefix + 1, newLine = prefix + 1, hunk;
    for (const op of ops) {
      if (op.type === '=') { hunk = null; oldLine++; newLine++; continue; }
      if (!hunk) { hunk = { id: 'h' + (hunks.length + 1), oldStart: oldLine, newStart: newLine, oldLines: [], newLines: [], oldCount: 0, newCount: 0, decision: 'pending' }; hunks.push(hunk); }
      if (op.type === '-') { hunk.oldLines.push(op.text); hunk.oldCount++; oldLine++; }
      else { hunk.newLines.push(op.text); hunk.newCount++; newLine++; }
    }
    for (const item of hunks) item.type = !item.oldCount ? 'added' : !item.newCount ? 'deleted' : 'modified';
    return hunks;
  }
  function compose(record, decisions, baseline = false) {
    const original = lines(record.before), parts = []; let cursor = 0;
    for (const hunk of record.hunks) {
      parts.push(original.slice(cursor, hunk.oldStart - 1).join(''));
      const decision = decisions?.[hunk.id] || hunk.decision;
      const useOld = baseline ? decision !== 'accepted' : decision === 'rejected';
      parts.push((useOld ? hunk.oldLines : hunk.newLines).join('')); cursor = hunk.oldStart - 1 + hunk.oldCount;
    }
    parts.push(original.slice(cursor).join('')); return parts.join('');
  }
  function create(hooks = {}) {
    const document = hooks.document || root.document, stores = new Map();
    let destroyed = false, overlay = null, overlayEditor = null, overlayModels = [], overlaySelection = -1, overlayData = null, diffResize = null, diffFrame = 0;
    let decorationModel = null, decorationIds = [], decorationEpoch = 0, refreshEpoch = 0, showEpoch = 0, focusBefore = null, widgetEditor = null, widgetModel = null, widgetSignature = '', widgets = [], modelTimer = 0;
    const get = (name, fallback) => typeof hooks[name] === 'function' ? hooks[name]() : hooks[name] ?? fallback;
    const project = () => get('project', null), files = () => get('files', project()?.files || new Map());
    const editor = () => get('editor', null), monaco = () => get('monaco', root.monaco), bridge = () => get('bridge', root.iexaDesktop?.ide);
    const t = key => words[key]?.[(root.IexaI18n?.getLocale?.() || 'zh-CN').startsWith('en') ? 1 : (root.IexaI18n?.getLocale?.() || '').startsWith('ja') ? 2 : 0] || key;
    const state = id => { if (!stores.has(id)) stores.set(id, { git: null, reviews: new Map(), baseline: new Map(), error: '', refreshing: false }); return stores.get(id); };
    const announce = (text, error) => { hooks.message?.(text, !!error); const live = document.getElementById('ideChangesNotice'); if (live) live.textContent = text; };
    const invoke = async (name, input) => { if (!bridge()?.[name]) throw Error(t('noGit')); const value = await bridge()[name](input); if (value?.ok === false) throw Error(value.error?.message || value.error || name); return value; };
    const element = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
    const button = (label, action, cls = '') => { const el = element('button', cls, label); el.type = 'button'; el.addEventListener('click', () => Promise.resolve().then(action).catch(error => announce(error.message, true))); return el; };
    const fileFor = (path, workspaceId = project()?.id) => workspaceId === project()?.id ? files()?.get?.(path) || (Array.isArray(files()) ? files().find(file => file.path === path) : undefined) : hooks.fileFor?.(workspaceId, path);
    function normalizeStatus(entry) {
      const index = entry.index ?? entry.indexStatus ?? ' ', workTree = entry.workTree ?? entry.worktreeStatus ?? ' ';
      const conflict = !!entry.conflict || index === 'U' || workTree === 'U' || ['DD', 'AA'].includes(index + workTree);
      const status = conflict ? '!' : entry.untracked || index === '?' || workTree === '?' ? 'U' : entry.status || (workTree.trim() ? workTree : index.trim() ? index : 'M');
      return { ...entry, path: String(entry.path || ''), status, index, workTree, conflict, staged: conflict ? false : entry.staged ?? /[^ ?!]/.test(index), untracked: status === 'U', originalPath: entry.originalPath || entry.oldPath || '' };
    }
    function statusTitle(item) {
      const statusKey = ({ M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'added', U: 'untracked', '!': 'conflict' })[item.status] || 'modified';
      return [t(statusKey), item.originalPath ? item.originalPath + ' → ' + item.path : item.path, item.staged ? t('staged') : '', item.workTree.trim() && item.workTree !== '?' ? t('unstaged') : ''].filter(Boolean).join(' · ');
    }
    function reviewFor(path, workspaceId = project()?.id) { return [...(stores.get(workspaceId)?.reviews.values() || [])].filter(item => item.path === path).at(-1); }
    function decorate() {
      const id = project()?.id, info = id && state(id), entries = (info?.git?.files || []).map(normalizeStatus);
      for (const target of document.querySelectorAll('#ideTree [data-path], #ideEditorTabs [data-path]')) {
        target.querySelectorAll(':scope > .ide-git-badge,:scope > .ide-ai-review-badge').forEach(el => el.remove()); delete target.dataset.gitStatus; delete target.dataset.aiReview;
        const path = target.dataset.path, directory = target.dataset.directory === 'true';
        const item = entries.find(entry => entry.path === path) || (directory && entries.find(entry => entry.path.startsWith(path + '/')));
        if (item) { target.dataset.gitStatus = item.status; const badge = element('span', 'ide-git-badge', directory ? '●' : item.status); badge.dataset.status = item.status; badge.title = statusTitle(item); badge.setAttribute('aria-label', badge.title); if (item.staged) { badge.dataset.staged = 'true'; badge.textContent += '·'; } target.append(badge); }
        const review = [...(info?.reviews.values() || [])].find(record => (record.path === path || directory && record.path.startsWith(path + '/')) && record.hunks.some(hunk => hunk.decision === 'pending'));
        if (review) { const badge = element('span', 'ide-ai-review-badge', 'AI'); badge.title = t('pending'); badge.setAttribute('aria-label', t('pending')); target.dataset.aiReview = 'pending'; target.append(badge); }
      }
      // Status-bar rendering runs during typing. Do not copy every captured
      // source buffer just to count pending blocks.
      hooks.onRender?.({ workspaceId: id || '', git: info?.git || null, error: info?.error || '', reviews: [...(info?.reviews.values() || [])].map(record => ({ id: record.id, path: record.path, revision: record.revision, hunks: record.hunks.map(hunk => ({ id: hunk.id, decision: hunk.decision })) })), overlay: overlay ? { source: overlayData?.source || 'list', path: overlayData?.path || '' } : null });
    }
    async function refresh() {
      const current = project(); if (!current || destroyed) return null;
      const id = current.id, info = state(id), epoch = ++refreshEpoch; info.refreshing = true;
      try { const result = await invoke('gitStatus', { workspaceId: id }); if (destroyed || epoch !== refreshEpoch || project()?.id !== id) return result; info.git = { ...result, files: (result.files || result.entries || []).filter(entry => !entry.ignored).map(normalizeStatus) }; info.baseline.clear(); info.error = result.error || ''; decorate(); await updateDecorations(); return result; }
      catch (error) { if (epoch === refreshEpoch) { info.git = null; info.error = error.message; decorate(); } return null; }
      finally { info.refreshing = false; }
    }
    async function gitDiff(path, ref = 'index', workspaceId = project()?.id) {
      const result = await invoke('gitDiff', { workspaceId, path, ref });
      const original = result.original || { content: result.baseContent || '', exists: true }, modified = result.modified || { content: result.currentContent || '', exists: true, revision: result.revision };
      return { ...result, original, modified, before: original.content || '', after: modified.content || '', binary: original.binary || modified.binary };
    }
    function clearWidgets() { for (const widget of widgets) widgetEditor?.removeContentWidget?.(widget); widgets = []; widgetEditor = null; widgetModel = null; widgetSignature = ''; }
    function clearDecorations() { clearWidgets(); if (decorationModel?.deltaDecorations && !decorationModel.isDisposed?.()) decorationModel.deltaDecorations(decorationIds, []); else if (editor()?.deltaDecorations && decorationIds.length) editor().deltaDecorations(decorationIds, []); decorationIds = []; decorationModel = null; }
    function positions(record) { let shift = 0; return record.hunks.map(hunk => { const item = { ...hunk, currentStart: hunk.newStart + shift }; if (hunk.decision === 'rejected') shift += hunk.oldCount - hunk.newCount; return item; }); }
    async function updateDecorations(cached = false) {
      const ed = editor(), model = ed?.getModel?.(), current = project(), epoch = ++decorationEpoch, path = current?.activePath || hooks.activePath?.();
      if (!model || !current || !path) { clearDecorations(); return; }
      let changes = [], review = reviewFor(path);
      try {
        const info = state(current.id), status = info.git?.files.find(item => item.path === path), ref = status?.staged && !status.workTree.trim() ? 'HEAD' : 'index', key = path + '\0' + ref;
        let source = info.baseline.get(key);
        if (!source && !cached) { source = await gitDiff(path, ref); info.baseline.set(key, source); }
        if (source && !source.binary) changes = diffHunks(source.before, model.getValue());
      } catch { /* AI edits remain visible in non-repositories. */ }
      if (destroyed || epoch !== decorationEpoch || current.id !== project()?.id || model !== editor()?.getModel?.()) return;
      const decorations = changes.map(hunk => decoration(hunk.newStart, hunk.newCount, hunk.type, false));
      const pending = review && model.getValue() === compose(review) ? positions(review).filter(item => item.decision === 'pending') : [];
      for (const hunk of pending) decorations.push(decoration(hunk.currentStart, hunk.newCount, hunk.type, true));
      if (decorationModel && decorationModel !== model) clearDecorations(); decorationModel = model;
      if (model.deltaDecorations) decorationIds = model.deltaDecorations(decorationIds, decorations); else if (ed.deltaDecorations) decorationIds = ed.deltaDecorations(decorationIds, decorations);
      const signature = review ? [review.id, review.revision, review.busy, fileFor(path)?.dirty, model.getVersionId?.(), ...pending.map(hunk => `${hunk.id}:${hunk.currentStart}:${hunk.newCount}`)].join('|') : '';
      if (widgetEditor !== ed || widgetModel !== model || widgetSignature !== signature) {
        clearWidgets(); widgetSignature = signature; widgetModel = model;
      } else return decorations;
      if (review && ed.addContentWidget) {
        widgetEditor = ed;
        // The full review view contains every block; cap inline widgets so a
        // generated file with thousands of edits does not create thousands of DOM nodes.
        for (const hunk of pending.slice(0, 40)) {
          const row = element('div', 'ide-inline-review'); row.dataset.reviewId = review.id; row.dataset.hunkId = hunk.id;
          row.append(button(t('accept'), () => reviewDecision(review.id, hunk.id, 'accept')), button(t('reject'), () => reviewDecision(review.id, hunk.id, 'reject')), button('↗', () => showDiff(path, 'ai')));
          const disabled = !!fileFor(path)?.dirty || !!review.busy; row.querySelectorAll('button').forEach(control => { control.disabled = disabled; });
          const lineNumber = Math.min(model.getLineCount?.() || Infinity, Math.max(1, hunk.currentStart));
          const widget = { allowEditorOverflow: false, suppressMouseDown: true, getId: () => 'iexa-ai-' + review.id + '-' + hunk.id, getDomNode: () => row, getPosition: () => ({ position: { lineNumber, column: 1 }, preference: [monaco()?.editor?.ContentWidgetPositionPreference?.ABOVE ?? 1, monaco()?.editor?.ContentWidgetPositionPreference?.BELOW ?? 2] }) };
          widgets.push(widget); ed.addContentWidget(widget);
        }
      }
      return decorations;
    }
    function queueDecorations() { clearTimeout(modelTimer); modelTimer = setTimeout(() => { modelTimer = 0; if (!destroyed) updateDecorations(true).catch(error => announce(error.message, true)); }, 100); }
    function onModelChange() { decorate(); queueDecorations(); }
    const reviewDecision = (...args) => review(...args);
    function decoration(start, count, type, ai) {
      const color = ai ? '#a78bfa' : ({ added: '#4ab488', modified: '#4c9ee8', deleted: '#df6670' })[type];
      return { range: { startLineNumber: Math.max(1, start), startColumn: 1, endLineNumber: Math.max(1, start + Math.max(1, count) - 1), endColumn: 1 }, options: { isWholeLine: true, linesDecorationsClassName: 'ide-change-gutter ' + (ai ? 'ide-change-ai' : 'ide-change-' + type), overviewRuler: { color, position: monaco()?.editor?.OverviewRulerLane?.Left || 1 }, minimap: { color, position: 1 }, hoverMessage: { value: ai ? t('pending') : t(type) }, stickiness: 1 } };
    }
    function applyReviewRecord(input) {
      if (!input?.workspaceId || !input.path || !input.id) throw Error('AI review requires id, workspaceId and path');
      const before = typeof input.before === 'object' ? input.before?.content || '' : input.before || '', after = typeof input.after === 'object' ? input.after?.content || '' : input.after || '';
      const beforeExists = input.beforeExists ?? (typeof input.before === 'object' ? input.before?.exists !== false : true), afterExists = input.afterExists ?? (typeof input.after === 'object' ? input.after?.exists !== false : true);
      const info = state(input.workspaceId), previous = info.reviews.get(input.id);
      if (previous?.busy) { previous.queuedRecord = input; return publicRecord(previous); }
      const hunks = diffHunks(before, after);
      if (!hunks.length && beforeExists !== afterExists) hunks.push({ id: 'h1', oldStart: 1, newStart: 1, oldLines: lines(before), newLines: lines(after), oldCount: lines(before).length, newCount: lines(after).length, type: beforeExists ? 'deleted' : 'added', decision: 'pending' });
      for (const hunk of hunks) hunk.decision = input.decisions?.[hunk.id] || previous?.hunks.find(item => item.id === hunk.id && item.oldLines.join('') === hunk.oldLines.join('') && item.newLines.join('') === hunk.newLines.join(''))?.decision || 'pending';
      const record = { ...input, before, after, beforeExists, afterExists, revision: input.currentRevision ?? input.revision ?? input.after?.revision, hunks, busy: false, error: '' }; info.reviews.set(record.id, record);
      decorate(); if (project()?.id === input.workspaceId) updateDecorations(); if (overlayData?.reviewId === record.id) renderReview(record); return publicRecord(record);
    }
    function removeReviewRecord(id, workspaceId = project()?.id) { const info = stores.get(workspaceId); if (!info) return; info.reviews.delete(id); decorate(); updateDecorations(); if (overlayData?.reviewId === id) closeDiff(); }
    function setReviewRecords(records, workspaceId = project()?.id) {
      if (!workspaceId) return; const info = state(workspaceId), ids = new Set(records.map(record => record.id));
      for (const [id, record] of info.reviews) if (!ids.has(id) && !record.busy) info.reviews.delete(id);
      for (const input of records) { const pending = info.reviews.get(input.id); if (pending?.busy) { pending.queuedRecord = input; continue; } applyReviewRecord(input); }
      decorate(); return snapshot();
    }
    function publicRecord(record) { return { ...record, hunks: record.hunks.map(hunk => ({ ...hunk, oldLines: [...hunk.oldLines], newLines: [...hunk.newLines] })), decisions: Object.fromEntries(record.hunks.map(hunk => [hunk.id, hunk.decision])), currentRevision: record.revision, content: compose(record) }; }
    async function readCurrent(record) {
      try { return { ...(await invoke('read', { workspaceId: record.workspaceId, path: record.path })), exists: true }; }
      catch (error) { if (record.afterExists === false && /ENOENT|not found|不存在|已删除|IDE_NOT_FOUND/i.test((error.code || '') + ' ' + error.message)) return { exists: false, content: '', revision: record.revision }; throw error; }
    }
    async function verifyReview(record) {
      const file = fileFor(record.path, record.workspaceId); if (file?.dirty || file?.saving || file?.conflict || file?.missing && record.afterExists) throw Error(t('dirty'));
      const current = await readCurrent(record), expected = compose(record);
      if (!!current.exists !== !!record.afterExists || current.content !== expected || record.revision && current.revision !== record.revision) throw Error(t('stale'));
      // A clean model for a deleted file deliberately retains its last contents.
      // It is not an unsaved user draft and must not block reviewing the deletion.
      if (file?.model && !file.missing && file.model.getValue() !== expected) throw Error(t('dirty')); return current;
    }
    async function review(reviewId, hunkId, action) {
      if (!['accepted', 'rejected', 'accept', 'reject'].includes(action)) throw Error('Unknown review decision');
      const decision = action.startsWith('accept') ? 'accepted' : 'rejected', record = [...stores.values()].map(info => info.reviews.get(reviewId)).find(Boolean);
      if (!record) throw Error(t('noReview')); if (record.busy) return false;
      const hunk = record.hunks.find(item => item.id === hunkId); if (!hunk || hunk.decision !== 'pending') return false;
      record.busy = true; record.error = ''; renderBusy(record);
      try {
        const current = await verifyReview(record), decisions = { ...Object.fromEntries(record.hunks.map(item => [item.id, item.decision])), [hunk.id]: decision };
        const nextContent = compose(record, decisions), pending = record.hunks.filter(item => decisions[item.id] === 'pending').length;
        const desiredExists = decision === 'rejected' && !pending && record.hunks.every(item => decisions[item.id] === 'rejected') ? record.beforeExists : record.afterExists;
        const request = { action: decision === 'accepted' ? 'accept' : 'reject', hunkId, content: nextContent, baseline: compose(record, decisions, true), exists: desiredExists, remove: !desiredExists, revision: current.revision, complete: !pending, decisions };
        let result;
        if (hooks.applyReviewDecision) result = await hooks.applyReviewDecision(publicRecord(record), request);
        else if (decision === 'rejected') { if (!current.exists || !desiredExists) throw Error(t('protection')); result = await invoke('write', { workspaceId: record.workspaceId, path: record.path, content: nextContent, revision: current.revision }); }
        record.revision = result?.revision ?? result?.record?.revision ?? result?.currentRevision ?? current.revision; record.afterExists = result?.exists ?? (result?.removed ? false : desiredExists);
        hunk.decision = decision;
        if (decision === 'rejected') await hooks.syncFile?.(record.path, record.workspaceId, result);
        await hooks.onReviewChange?.(publicRecord(record), { ...request, currentRevision: record.revision, exists: record.afterExists, allResolved: !pending });
        decorate(); await updateDecorations(); if (overlayData?.reviewId === record.id) renderReview(record); return true;
      } catch (error) { record.error = error.message; announce(error.message, true); if (overlayData?.reviewId === record.id) renderReview(record); throw error; }
      finally { record.busy = false; renderBusy(record); if (record.queuedRecord && record.queuedRecord.revision === record.revision) applyReviewRecord(record.queuedRecord); }
    }
    async function reviewAll(action, workspaceId = project()?.id, reviewId) {
      const ids = [...(stores.get(workspaceId)?.reviews.values() || [])].filter(record => !reviewId || record.id === reviewId).map(record => record.id); let count = 0;
      for (const id of ids) for (;;) {
        // The host rebases its captured baseline after each accepted block.
        // Read the current record again instead of reusing obsolete hunk IDs.
        const record = stores.get(workspaceId)?.reviews.get(id), hunk = record?.hunks.find(item => item.decision === 'pending');
        if (!hunk || record.busy) break; if (!(await review(id, hunk.id, action))) break; count++;
      }
      return count;
    }
    function renderBusy(record) { if (overlayData?.reviewId === record.id && overlay) overlay.querySelectorAll('[data-review-action]').forEach(el => { el.disabled = record.busy; }); }
    async function showDiff(path, source = 'git', options = {}) {
      const current = project(), epoch = ++showEpoch; if (!current) return;
      path = path || current.activePath || hooks.activePath?.(); if (!path) { await showChanges(); return; }
      const id = current.id, record = source === 'ai' ? reviewFor(path, id) : null;
      if (source === 'ai' && !record) { announce(t('noReview')); return; }
      const data = source === 'ai' ? { before: record.before, after: compose(record), binary: record.binary } : await gitDiff(path, options.ref || 'index', id);
      if (project()?.id !== id || destroyed || epoch !== showEpoch) return;
      closeDiff(false, true); focusBefore = document.activeElement;
      overlayData = { path, source, workspaceId: id, reviewId: record?.id, ref: options.ref || 'index', ...data };
      overlay = element('section', 'ide-changes-overlay'); overlay.id = 'ideChangesOverlay'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'false'); overlay.setAttribute('aria-label', t(source === 'ai' ? 'ai' : 'git') + ' · ' + path);
      const header = element('header', 'ide-changes-header'), title = element('strong', '', path); title.title = path; header.append(title);
      const sourceSelect = element('select'); sourceSelect.setAttribute('aria-label', t('changes'));
      for (const [value, label] of [['git', 'git'], ['ai', 'ai']]) { const option = element('option', '', t(label)); option.value = value; option.disabled = value === 'ai' && !reviewFor(path); sourceSelect.append(option); }
      sourceSelect.value = source; sourceSelect.addEventListener('change', () => showDiff(path, sourceSelect.value).catch(error => announce(error.message, true))); header.append(sourceSelect);
      if (source === 'git') {
        const ref = element('select'); ref.setAttribute('aria-label', t('git'));
        for (const [value, label] of [['index', 'index'], ['HEAD', 'head']]) { const option = element('option', '', t(label)); option.value = value; ref.append(option); }
        ref.value = overlayData.ref; ref.addEventListener('change', () => showDiff(path, 'git', { ref: ref.value }).catch(error => announce(error.message, true))); header.append(ref);
      }
      header.append(button('↑', () => navigate(-1), 'ide-changes-prev'), button('↓', () => navigate(1), 'ide-changes-next'), button('×', () => closeDiff(), 'ide-changes-close'));
      for (const [cls, key] of [['prev', 'previous'], ['next', 'next'], ['close', 'close']]) { const control = header.querySelector('.ide-changes-' + cls); control.title = t(key); control.setAttribute('aria-label', t(key)); }
      const notice = element('p', 'ide-changes-notice', t(source === 'ai' ? 'hint' : 'git')); notice.id = 'ideChangesNotice'; notice.setAttribute('role', 'status');
      const canvas = element('div', 'ide-changes-diff'); canvas.id = 'ideChangesDiff';
      const hunkHost = element('div', 'ide-changes-hunks'); hunkHost.id = 'ideChangesHunks'; overlay.append(header, notice, canvas, hunkHost);
      (hooks.mount || document.getElementById('idePanel') || document.body).append(overlay); const view = overlay; hooks.overlayChanged?.(true); await hooks.hideNative?.();
      if (view !== overlay || epoch !== showEpoch || destroyed) return;
      if (data.binary) canvas.append(element('p', '', t('binary')));
      else {
        const api = monaco();
        if (api?.editor?.createDiffEditor && api.editor.createModel) {
          overlayEditor = api.editor.createDiffEditor(canvas, { readOnly: true, originalEditable: false, automaticLayout: false, renderSideBySide: overlay.clientWidth >= 720, minimap: { enabled: false }, scrollBeyondLastLine: false, renderOverviewRuler: true, enableSplitViewResizing: true, theme: document.documentElement.dataset.theme === 'dark' ? 'vs-dark' : 'vs' });
          const language = fileFor(path)?.model?.getLanguageId?.(); overlayModels = [api.editor.createModel(data.before, language), api.editor.createModel(data.after, language)]; overlayEditor.setModel({ original: overlayModels[0], modified: overlayModels[1] });
          // Layout writes during a ResizeObserver delivery can trigger a loop.
          // Defer the measured change to the next animation frame and skip sizes
          // already applied; preserve every renderer error for diagnostics.
          let size = '';
          const resize = () => {
            if (diffFrame) return;
            diffFrame = root.requestAnimationFrame(() => { diffFrame = 0; if (!overlayEditor || view !== overlay) return; const width = canvas.clientWidth, height = canvas.clientHeight, next = width + ':' + height; if (width > 0 && height > 0 && next !== size) { size = next; overlayEditor.layout?.({ width, height }); } });
          };
          if (root.ResizeObserver) { diffResize = new root.ResizeObserver(resize); diffResize.observe(canvas); } resize();
        } else renderTextDiff(canvas, diffHunks(data.before, data.after));
      }
      if (record) renderReview(record); else renderGitHunks(diffHunks(data.before, data.after));
      overlay.querySelector('.ide-changes-close').focus(); return overlayData;
    }
    function renderTextDiff(host, hunks) {
      const pre = element('pre', 'ide-changes-text');
      for (const hunk of hunks) { pre.append(element('span', 'ide-changes-hunk-caption', `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`)); for (const line of hunk.oldLines) pre.append(element('span', 'ide-changes-line-removed', '-' + line)); for (const line of hunk.newLines) pre.append(element('span', 'ide-changes-line-added', '+' + line)); }
      host.replaceChildren(pre);
    }
    function renderGitHunks(hunks) {
      const host = document.getElementById('ideChangesHunks'); if (!host) return; host.replaceChildren();
      if (!hunks.length) host.append(element('p', '', t('empty')));
      for (const hunk of hunks) host.append(button(`−${hunk.oldCount} +${hunk.newCount} · ${hunk.newStart}`, () => reveal(hunk.newStart), 'ide-change-jump'));
    }
    function renderReview(record) {
      const host = document.getElementById('ideChangesHunks'); if (!host) return; host.replaceChildren();
      const controls = element('div', 'ide-review-actions');
      for (const [label, action] of [['acceptAll', 'accept'], ['rejectAll', 'reject']]) { const el = button(t(label), () => reviewAll(action, record.workspaceId, record.id)); el.dataset.reviewAction = action; el.disabled = !record.hunks.some(hunk => hunk.decision === 'pending'); controls.append(el); } host.append(controls);
      if (!record.hunks.some(hunk => hunk.decision === 'pending')) host.append(element('p', '', t('noReview')));
      for (const hunk of positions(record)) {
        const row = element('section', 'ide-review-hunk'); row.dataset.hunkId = hunk.id; row.dataset.decision = hunk.decision;
        row.append(button(`−${hunk.oldCount} +${hunk.newCount} · ${hunk.currentStart}`, () => reveal(hunk.currentStart), 'ide-change-jump'));
        if (hunk.decision === 'pending') for (const [label, action] of [['accept', 'accept'], ['reject', 'reject']]) { const el = button(t(label), () => review(record.id, hunk.id, action)); el.dataset.reviewAction = action; row.append(el); }
        else row.append(element('span', 'ide-review-decision', t(hunk.decision))); host.append(row);
      }
      if (record.error) host.append(element('p', 'ide-changes-error', record.error));
      if (overlayModels[1]) overlayModels[1].setValue(compose(record)); else if (overlay) renderTextDiff(document.getElementById('ideChangesDiff'), diffHunks(record.before, compose(record))); renderBusy(record);
    }
    function reveal(line) { const target = overlayEditor?.getModifiedEditor?.() || overlayEditor || editor(); target?.revealLineInCenter?.(Math.max(1, line)); target?.setPosition?.({ lineNumber: Math.max(1, line), column: 1 }); }
    async function navigate(direction = 1) {
      const current = project(); if (!current) return; let hunks;
      if (overlayData?.source === 'ai') { const record = state(overlayData.workspaceId).reviews.get(overlayData.reviewId); hunks = record ? positions(record).filter(hunk => hunk.decision === 'pending').map(hunk => ({ ...hunk, newStart: hunk.currentStart })) : []; }
      else if (overlayData) hunks = diffHunks(overlayData.before, overlayData.after);
      else {
        const path = current.activePath || hooks.activePath?.(); if (!path) return;
        try { const data = await gitDiff(path); hunks = diffHunks(data.before, editor()?.getModel?.()?.getValue?.() ?? data.after); }
        catch { const record = reviewFor(path); hunks = record ? positions(record).filter(item => item.decision === 'pending').map(item => ({ ...item, newStart: item.currentStart })) : []; }
      }
      if (!hunks?.length) return;
      if (overlayData) { overlaySelection = overlaySelection < 0 ? direction < 0 ? hunks.length - 1 : 0 : (overlaySelection + (direction < 0 ? -1 : 1) + hunks.length) % hunks.length; reveal(hunks[overlaySelection].newStart); return hunks[overlaySelection]; }
      const line = editor()?.getPosition?.()?.lineNumber || 1, hunk = direction < 0 ? [...hunks].reverse().find(item => item.newStart < line) || hunks.at(-1) : hunks.find(item => item.newStart > line) || hunks[0]; reveal(hunk.newStart); return hunk;
    }
    function closeDiff(restore = true, preserveRequest = false) {
      if (!preserveRequest) showEpoch++;
      if (!overlay) return; diffResize?.disconnect(); diffResize = null; if (diffFrame) root.cancelAnimationFrame(diffFrame); diffFrame = 0;
      overlayEditor?.dispose?.(); overlayEditor = null; overlayModels.forEach(model => model.dispose?.()); overlayModels = [];
      overlay.remove(); overlay = null; overlayData = null; overlaySelection = -1; hooks.overlayChanged?.(false); hooks.scheduleLayout?.(); if (restore && focusBefore?.isConnected) focusBefore.focus?.();
    }
    async function showChanges() {
      const id = project()?.id, epoch = ++showEpoch; if (!id) return;
      await refresh(); if (destroyed || epoch !== showEpoch || project()?.id !== id) return;
      const info = state(id); closeDiff(false, true); focusBefore = document.activeElement;
      overlay = element('section', 'ide-changes-overlay ide-changes-list'); overlay.id = 'ideChangesOverlay'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'false'); overlay.setAttribute('aria-label', t('changes'));
      const header = element('header', 'ide-changes-header'); header.append(element('strong', '', t('changes')), button('↻', () => showChanges()), button('×', () => closeDiff(), 'ide-changes-close')); header.querySelector('.ide-changes-close').setAttribute('aria-label', t('close')); overlay.append(header);
      const reviews = [...info.reviews.values()].filter(record => record.hunks.some(hunk => hunk.decision === 'pending'));
      if (reviews.length) { overlay.append(element('h3', '', t('ai'))); for (const record of reviews) { const row = button(record.path + ' · ' + record.hunks.filter(hunk => hunk.decision === 'pending').length, () => showDiff(record.path, 'ai'), 'ide-changes-file'); row.dataset.reviewId = record.id; overlay.append(row); } }
      overlay.append(element('h3', '', t('git') + (info.git?.branch ? ' · ' + info.git.branch : ''))); const entries = (info.git?.files || []).map(normalizeStatus);
      if (!entries.length) overlay.append(element('p', '', info.error || t(info.git?.repository ? 'empty' : info.git?.available === false || !info.git ? 'noGit' : 'notRepo')));
      for (const entry of entries) { const row = button('', () => showDiff(entry.path, 'git', { ref: entry.workTree.trim() && entry.workTree !== '?' ? 'index' : 'HEAD' }), 'ide-changes-file'); row.dataset.path = entry.path; const badge = element('span', 'ide-git-badge', entry.status + (entry.staged ? '·' : '')); badge.dataset.status = entry.status; row.append(badge, element('span', '', entry.originalPath ? entry.originalPath + ' → ' + entry.path : entry.path)); row.title = statusTitle(entry); overlay.append(row); }
      (hooks.mount || document.getElementById('idePanel') || document.body).append(overlay); const view = overlay; hooks.overlayChanged?.(true); await hooks.hideNative?.(); if (view === overlay && epoch === showEpoch) overlay.querySelector('.ide-changes-close').focus();
    }
    function snapshot() { const info = project()?.id && state(project().id); return { workspaceId: project()?.id || '', git: info?.git ? { ...info.git, files: [...info.git.files] } : null, error: info?.error || '', reviews: [...(info?.reviews.values() || [])].map(publicRecord), overlay: overlay ? { source: overlayData?.source || 'list', path: overlayData?.path || '' } : null }; }
    const onKey = event => { if (!overlay || event.isComposing) return; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDiff(); } if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); navigate(event.key === 'ArrowUp' ? -1 : 1); } };
    document.addEventListener('keydown', onKey, true);
    function destroy() { destroyed = true; refreshEpoch++; decorationEpoch++; clearTimeout(modelTimer); closeDiff(false); clearDecorations(); document.removeEventListener('keydown', onKey, true); stores.clear(); }
    return Object.freeze({ refresh, decorate, updateDecorations, queueDecorations, onModelChange, showChanges, showDiff, closeDiff, navigate, applyReviewRecord, removeReviewRecord, setReviewRecords, review, reviewAll, snapshot, isOpen: () => !!overlay, destroy });
  }
  root.IexaIDEChanges = Object.freeze({ create, diffHunks });
})(typeof window === 'undefined' ? globalThis : window);
