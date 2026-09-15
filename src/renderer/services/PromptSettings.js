/* Project context and opt-in diagnostics. Rendering is text-only. */
(function (global) {
  class PromptSettings {
    constructor({ apiBase = '', getSessionId }) {
      this.apiBase = apiBase;
      this.getSessionId = getSessionId;
      this.projectRoot = null;
      this.generation = 0;
      this.saving = false;
      this.previewSession = null;
      this.el('scopeReloadBtn').addEventListener('click', () => this.loadScope());
      this.el('scopeSaveBtn').addEventListener('click', () => this.saveScope());
      this.el('promptArmBtn').addEventListener('click', () => this.preview('POST'));
      this.el('promptRefreshBtn').addEventListener('click', () => this.preview('GET'));
      this.el('promptClearBtn').addEventListener('click', () => this.preview('DELETE'));
    }
    el(id) { return document.getElementById(id); }
    async request(route, options) {
      const response = await fetch(this.apiBase + route, options);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    async loadScope() {
      const generation = ++this.generation;
      this.projectRoot = null;
      this.el('scopeSaveBtn').disabled = true;
      this.el('scopeProjectRoot').textContent = '正在读取项目…';
      this.el('scopeFeedback').textContent = '';
      for (const id of ['scopeTargets', 'scopeOperations', 'scopeNotes']) this.el(id).value = '';
      try {
        const data = await this.request('/api/project/scope');
        if (generation !== this.generation) return;
        this.projectRoot = data.projectRoot;
        this.el('scopeProjectRoot').textContent = data.projectRoot;
        this.el('scopeTargets').value = data.scope.targets.join('\n');
        this.el('scopeOperations').value = data.scope.operations.join('\n');
        this.el('scopeNotes').value = data.scope.notes;
      } catch (error) {
        if (generation === this.generation) this.el('scopeProjectRoot').textContent = error.message;
      } finally {
        if (generation === this.generation) this.el('scopeSaveBtn').disabled = !this.projectRoot || this.saving;
      }
    }
    async saveScope() {
      if (!this.projectRoot || this.saving) return;
      this.saving = true;
      const generation = this.generation;
      this.el('scopeSaveBtn').disabled = true;
      const lines = id => this.el(id).value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      try {
        await this.request('/api/project/scope', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectRoot: this.projectRoot, scope: {
            targets: lines('scopeTargets'), operations: lines('scopeOperations'), notes: this.el('scopeNotes').value,
          } }),
        });
        if (generation === this.generation) this.el('scopeFeedback').textContent = '已保存；下一轮对话复用此范围。';
      } catch (error) {
        if (generation === this.generation) this.el('scopeFeedback').textContent = error.message;
      } finally {
        this.saving = false;
        this.el('scopeSaveBtn').disabled = !this.projectRoot;
      }
    }
    async preview(method) {
      const sessionId = this.getSessionId();
      const output = this.el('promptPreviewText'), status = this.el('promptPreviewStatus');
      clearTimeout(this.previewTimer);
      output.textContent = '';
      if (!sessionId) { status.textContent = '请先选择会话'; return; }
      this.previewSession = sessionId;
      const requestId = this.previewRequestId = (this.previewRequestId || 0) + 1;
      try {
        const data = await this.request('/api/prompt-preview?sessionId=' + encodeURIComponent(sessionId), { method });
        if (requestId !== this.previewRequestId || sessionId !== this.getSessionId()) return;
        if (data.preview) {
          status.textContent = `${data.preview.provider} / ${data.preview.model} · ${new Date(data.preview.capturedAt).toLocaleTimeString()}\n${data.preview.warning}${data.preview.truncated ? '\n预览超过 256,000 字符，已截断；模型输入未因此截断。' : ''}`;
          output.textContent = data.preview.text;
          // Remove displayed private content at the same deadline as the server snapshot.
          clearTimeout(this.previewTimer);
          this.previewTimer = setTimeout(() => { output.textContent = ''; status.textContent = '预览已过期'; }, Math.max(0, data.preview.expiresAt - Date.now()));
        } else status.textContent = data.armed ? '已启用一次采集。回到当前会话发送消息，再点击“读取预览”。5 分钟内有效。' : '暂无预览（未启用、已清除或已过期）。';
      } catch (error) {
        if (requestId === this.previewRequestId) status.textContent = error.message;
      }
    }
  }
  global.IexaPromptSettings = PromptSettings;
})(window);
