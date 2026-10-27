// Read a reply aloud with the neural voices from the intro film (default 云扬).
// Synthesis happens on the server, which splits long replies into segments;
// this module plays them back to back so the whole reply is heard, and owns the
// playback state so only one message talks at a time.
(function () {
  const state = { audio: null, button: null, messageEl: null, loading: false, token: 0 };

  function resetButton() {
    if (!state.button) return;
    state.button.classList.remove('is-speaking', 'is-loading');
    state.button.setAttribute('aria-pressed', 'false');
    state.button.setAttribute('title', '朗读内容');
    state.button.style.removeProperty('--speech-progress');
  }

  function stop() {
    state.token += 1;
    if (state.audio) {
      try { state.audio.pause(); } catch { /* already ended */ }
      state.audio.src = '';
      state.audio = null;
    }
    state.loading = false;
    resetButton();
    state.button = null;
    state.messageEl = null;
  }

  /** The raw markdown is the best source; the rendered text is the fallback. */
  function textOf(messageEl) {
    if (typeof messageEl._assistantText === 'string' && messageEl._assistantText.trim()) {
      return messageEl._assistantText;
    }
    const content = messageEl.querySelector('.message-content');
    return content ? content.textContent || '' : '';
  }

  /**
   * Play the segments one after another. Progress spans the whole reply, so a
   * three-segment answer does not jump back to zero when segment two starts.
   */
  function playSegments(urls, button, token) {
    const total = urls.length;
    let index = 0;

    return new Promise((resolve) => {
      const next = () => {
        if (token !== state.token || index >= total) { resolve(); return; }
        const audio = new Audio(urls[index]);
        state.audio = audio;

        audio.addEventListener('timeupdate', () => {
          if (token !== state.token) return;
          const within = audio.duration ? audio.currentTime / audio.duration : 0;
          const overall = ((index + Math.min(within, 1)) / total) * 100;
          button.style.setProperty('--speech-progress', String(overall));
        });
        // A gap between utterances would be heard as "it stopped"; advance as soon
        // as the element reports the clip is done.
        audio.addEventListener('ended', () => { index += 1; next(); });
        audio.addEventListener('error', () => { index += 1; next(); });
        audio.play().catch(() => { index += 1; next(); });
      };
      next();
    });
  }

  async function speak(messageEl, button) {
    const text = textOf(messageEl);
    if (!text.trim()) return;

    stop();
    const token = state.token;
    state.messageEl = messageEl;
    state.button = button;
    state.loading = true;
    button.classList.add('is-loading');
    button.setAttribute('aria-pressed', 'true');
    button.setAttribute('title', '正在合成…');

    try {
      const response = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await response.json().catch(() => ({}));
      if (token !== state.token) return;
      if (!response.ok) throw new Error(data.detail || data.error || '语音合成失败');

      const urls = Array.isArray(data.segments) && data.segments.length ? data.segments : [data.url];
      state.loading = false;
      state.button = button;
      state.messageEl = messageEl;
      button.classList.remove('is-loading');
      button.classList.add('is-speaking');
      button.setAttribute('title', '停止朗读');

      await playSegments(urls, button, token);
      if (token === state.token) stop();
    } catch (error) {
      if (token !== state.token) return;
      state.loading = false;
      resetButton();
      button.title = String(error.message || error);
      button.classList.add('is-failed');
      setTimeout(() => button.classList.remove('is-failed'), 1600);
      console.warn('speech failed', error);
    }
  }

  function toggle(messageEl, button) {
    if (state.messageEl === messageEl && (state.loading || state.audio)) { stop(); return; }
    void speak(messageEl, button);
  }

  function isBusy() {
    return Boolean(state.audio || state.loading);
  }

  // Switching conversations, sending a new message or leaving the view must not
  // keep talking over the new context.
  document.addEventListener('click', (event) => {
    if (!isBusy()) return;
    if (event.target.closest('.session-item, .nav-btn, #sendBtn, [data-action="retry"]')) stop();
  }, true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && isBusy()) stop(); });

  window.IexaSpeech = Object.freeze({ toggle, stop, isBusy });
})();
