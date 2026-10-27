// Read a reply aloud with the neural voices from the intro film (default 云扬).
// Synthesis happens on the server; this module only owns playback state, so a
// single message can play at a time and the button reflects the real audio state.
(function () {
  const state = { audio: null, button: null, messageEl: null, loading: false, token: 0 };

  function resetButton() {
    if (!state.button) return;
    state.button.classList.remove('is-speaking', 'is-loading');
    state.button.setAttribute('aria-pressed', 'false');
    state.button.removeAttribute('data-progress');
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

    try {
      const response = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await response.json().catch(() => ({}));
      if (token !== state.token) return;
      if (!response.ok) throw new Error(data.detail || data.error || '语音合成失败');

      const audio = new Audio(data.url);
      state.audio = audio;
      state.loading = false;
      button.classList.remove('is-loading');
      button.classList.add('is-speaking');

      audio.addEventListener('timeupdate', () => {
        if (!audio.duration) return;
        // A CSS variable, not attr(): attr() with a type is not supported in
        // Chromium, so the bar would stay at zero.
        button.style.setProperty('--speech-progress', String((audio.currentTime / audio.duration) * 100));
      });
      audio.addEventListener('ended', () => { if (token === state.token) stop(); });
      audio.addEventListener('error', () => { if (token === state.token) stop(); });
      await audio.play();
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
