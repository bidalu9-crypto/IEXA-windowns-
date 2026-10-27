/* Interactive question card for ask_user: pause the conversation, collect
   answers (single choice, multi choice, free text, confirm), then submit once.
   Multi-question cards are answered one question at a time. Answered cards fold
   down to the question they asked (plus a question count) and expand on demand. No innerHTML with user
   data — every dynamic value goes through textContent. */
(function () {
  'use strict';
  var cards = new Map(); // request id -> entry
  var TOOL_TERMINAL = { completed: 1, failed: 1, denied: 1, cancelled: 1, timed_out: 1 };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function makeButton(label, className) {
    var button = el('button', className, label);
    button.type = 'button';
    return button;
  }

  function iconSvg() {
    var span = el('span', 'question-card-icon');
    span.setAttribute('aria-hidden', 'true');
    // Speech-bubble mark, matching the app icon language without depending on app.js.
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 18.5 3.8 21l4-1.5A8.8 8.8 0 1 0 4 16.6"/><path d="M8 12h.01M12 12h.01M16 12h.01"/></svg>';
    return span;
  }

  function answerValue(question, record) {
    if (!record) return IexaI18n.t('question.unanswered');
    var parts = [];
    if (record.selected && record.selected.length) parts.push(record.selected.join('、'));
    var free = String(record.freeText || '').trim();
    if (free) parts.push(parts.length ? IexaI18n.t('question.supplement') + free : free);
    if (parts.length) return parts.join('；');
    if (record.skipped) return IexaI18n.t('question.skipped');
    return IexaI18n.t('question.unanswered');
  }

  function createEntry(data, options) {
    var questions = [];
    (Array.isArray(data.questions) ? data.questions : []).forEach(function (question) {
      if (!question || !question.id || !question.question) return;
      questions.push({
        id: String(question.id),
        header: question.header ? String(question.header) : '',
        question: String(question.question),
        options: Array.isArray(question.options) ? question.options : [],
        multiSelect: question.multiSelect === true,
        allowFreeText: question.allowFreeText === true || !(Array.isArray(question.options) && question.options.length),
        placeholder: question.placeholder ? String(question.placeholder) : '',
        kind: question.kind === 'confirm' ? 'confirm' : (Array.isArray(question.options) && question.options.length ? 'choice' : 'text'),
      });
    });
    if (!questions.length) return null;

    var answers = new Map();
    questions.forEach(function (question) { answers.set(question.id, { selected: [], freeText: '', skipped: false }); });

    var entry = {
      id: String(data.id),
      sessionId: data.sessionId ? String(data.sessionId) : '',
      toolCallId: data.toolCallId ? String(data.toolCallId) : '',
      state: 'awaiting',
      el: null,
      timer: undefined,
      options: options || {},
      reveal: function () { var opts = entry.options; if (typeof opts.scrollToBottom === 'function') { try { opts.scrollToBottom(); } catch (e) { /* view already gone */ } } },
      expire: function (message) { finalize(entry, 'closed', message); },
      interrupt: function (message) { finalize(entry, 'closed', message); },
      complete: function (message) { finalize(entry, 'closed', message); },
    };
    var index = 0;

    var root = el('div', 'question-card');
    root.dataset.requestId = entry.id;
    if (entry.toolCallId) root.dataset.toolCallId = entry.toolCallId;
    root.dataset.state = 'awaiting';
    root.setAttribute('role', 'group');
    root.setAttribute('tabindex', '-1');

    var titleId = 'qcard-title-' + entry.id.replace(/[^a-z0-9_-]/gi, '');
    var head = el('div', 'question-card-head');
    head.appendChild(iconSvg());
    var titleText = data.title ? String(data.title) : IexaI18n.t('question.needsAnswer');
    var titleEl = el('span', 'question-card-title', titleText);
    titleEl.id = titleId;
    root.setAttribute('aria-labelledby', titleId);
    head.appendChild(titleEl);
    var qmoreEl = el('span', 'question-card-qmore');
    qmoreEl.hidden = true;
    head.appendChild(qmoreEl);
    var progressEl = el('span', 'question-card-progress', '');
    head.appendChild(progressEl);
    var toggleBtn = makeButton('', 'question-card-toggle');
    toggleBtn.title = IexaI18n.t('question.expandDetails');
    toggleBtn.setAttribute('aria-label', IexaI18n.t('question.expandDetails'));
    toggleBtn.setAttribute('aria-expanded', 'false');
    var toggleChevron = el('span', 'question-card-chevron');
    toggleChevron.setAttribute('aria-hidden', 'true');
    toggleBtn.appendChild(toggleChevron);
    head.appendChild(toggleBtn);
    var closeBtn = makeButton('×', 'question-card-close');
    closeBtn.title = IexaI18n.t('question.cancel');
    closeBtn.setAttribute('aria-label', IexaI18n.t('question.cancel'));
    head.appendChild(closeBtn);
    root.appendChild(head);

    var previewEl = el('div', 'question-card-preview');
    previewEl.hidden = true;
    previewEl.title = IexaI18n.t('question.clickExpand');
    root.appendChild(previewEl);

    var dotsEl = el('div', 'question-card-dots');
    dotsEl.setAttribute('aria-hidden', 'true');
    root.appendChild(dotsEl);
    if (questions.length <= 1) dotsEl.hidden = true;

    var bodyEl = el('div', 'question-card-body');
    root.appendChild(bodyEl);

    var actionsEl = el('div', 'question-card-actions');
    var backBtn = makeButton(IexaI18n.t('question.prev'), 'question-nav question-back');
    var spacer = el('span', 'question-card-spacer');
    var skipBtn = makeButton(IexaI18n.t('question.skip'), 'question-nav question-skip');
    var nextBtn = makeButton(IexaI18n.t('question.next'), 'question-nav question-next is-primary');
    actionsEl.appendChild(backBtn);
    actionsEl.appendChild(spacer);
    actionsEl.appendChild(skipBtn);
    actionsEl.appendChild(nextBtn);
    root.appendChild(actionsEl);

    var noteEl = el('div', 'question-card-note');
    noteEl.setAttribute('role', 'status');
    root.appendChild(noteEl);

    entry.el = root;

    function currentQuestion() { return questions[index]; }
    function currentAnswer() { return answers.get(questions[index].id); }
    function isAnswered(question) {
      var record = answers.get(question.id);
      return record.selected.length > 0 || String(record.freeText || '').trim().length > 0 || record.skipped === true;
    }
    function allSettled() {
      return questions.every(isAnswered);
    }

    function renderDots() {
      dotsEl.textContent = '';
      if (questions.length <= 1) return;
      questions.forEach(function (question, dotIndex) {
        var dot = el('span', 'question-dot');
        if (dotIndex === index) dot.classList.add('is-current');
        if (answers.get(question.id).skipped) dot.classList.add('is-skipped');
        else if (isAnswered(question)) dot.classList.add('is-done');
        dot.title = IexaI18n.t('question.item', { index: dotIndex + 1 });
        dotsEl.appendChild(dot);
      });
    }

    function syncActions() {
      var last = index === questions.length - 1;
      progressEl.textContent = questions.length > 1 ? IexaI18n.t('question.of', { index: index + 1, total: questions.length }) : '';
      progressEl.hidden = questions.length <= 1;
      backBtn.disabled = index === 0 || entry.state !== 'awaiting';
      skipBtn.hidden = currentQuestion().kind === 'confirm';
      skipBtn.disabled = entry.state !== 'awaiting';
      skipBtn.classList.toggle('is-active', currentAnswer().skipped === true);
      nextBtn.textContent = last ? IexaI18n.t('question.submit') : IexaI18n.t('question.next');
      nextBtn.disabled = entry.state !== 'awaiting' || !isAnswered(currentQuestion()) || (last && !allSettled());
      closeBtn.disabled = entry.state !== 'awaiting';
      renderDots();
    }

    function renderQuestion() {
      var question = currentQuestion();
      var record = currentAnswer();
      root.dataset.kind = question.kind;
      bodyEl.textContent = '';

      var questionRow = el('div', 'question-card-question');
      if (question.header) questionRow.appendChild(el('span', 'question-chip', question.header));
      questionRow.appendChild(el('span', 'question-text', question.question));
      bodyEl.appendChild(questionRow);

      if (question.options.length) {
        var optionsEl = el('div', 'question-card-options');
        optionsEl.setAttribute('role', question.multiSelect ? 'group' : 'radiogroup');
        question.options.forEach(function (option) {
          var label = String(option && option.label || '');
          if (!label) return;
          var button = makeButton('', 'question-option');
          button.dataset.value = label;
          button.setAttribute('role', question.multiSelect ? 'checkbox' : 'radio');
          var selected = record.selected.indexOf(label) !== -1;
          button.classList.toggle('is-selected', selected);
          button.setAttribute('aria-checked', String(selected));
          var box = el('span', 'question-option-box');
          var main = el('span', 'question-option-main');
          main.appendChild(el('span', 'question-option-label', label));
          if (option && option.description) main.appendChild(el('span', 'question-option-desc', String(option.description)));
          button.appendChild(box);
          button.appendChild(main);
          button.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            if (entry.state !== 'awaiting') return;
            var recordNow = answers.get(question.id);
            var at = recordNow.selected.indexOf(label);
            if (question.multiSelect) {
              if (at === -1) recordNow.selected.push(label); else recordNow.selected.splice(at, 1);
            } else {
              recordNow.selected = at === -1 ? [label] : [];
            }
            recordNow.skipped = false;
            if (question.kind === 'confirm' && recordNow.selected.length) { void submit(); return; }
            renderQuestion();
            syncActions();
          });
          optionsEl.appendChild(button);
        });
        bodyEl.appendChild(optionsEl);
      }

      if (question.allowFreeText) {
        var inputWrap = el('div', 'question-card-input');
        var textarea = el('textarea', 'question-free-input');
        textarea.rows = 2;
        textarea.value = record.freeText || '';
        textarea.placeholder = question.placeholder || (question.options.length ? IexaI18n.t('question.otherPlaceholder') : IexaI18n.t('question.answerPlaceholder'));
        textarea.addEventListener('input', function () {
          if (entry.state !== 'awaiting') return;
          var recordNow = answers.get(question.id);
          recordNow.freeText = textarea.value;
          recordNow.skipped = false;
          skipBtn.classList.remove('is-active');
          syncActions();
          renderDots();
        });
        textarea.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (!nextBtn.disabled) advance();
          }
          event.stopPropagation();
        });
        inputWrap.appendChild(textarea);
        bodyEl.appendChild(inputWrap);
      }
      syncActions();
    }

    function renderSummary(message) {
      root.dataset.kind = 'summary';
      bodyEl.textContent = '';
      var list = el('div', 'question-card-summary');
      questions.forEach(function (question, questionIndex) {
        var row = el('div', 'question-answer-row');
        var qEl = el('span', 'question-answer-q', (questions.length > 1 ? (questionIndex + 1) + '. ' : '') + (question.header ? question.header + ' · ' : '') + question.question);
        var aEl = el('span', 'question-answer-a', answerValue(question, answers.get(question.id)));
        row.appendChild(qEl);
        row.appendChild(aEl);
        list.appendChild(row);
      });
      bodyEl.appendChild(list);
      actionsEl.hidden = true;
      dotsEl.hidden = true;
      progressEl.hidden = true;
      noteEl.textContent = message || '';
      noteEl.hidden = !message;
      refreshPreview();
      if (typeof entry.options.scrollToBottom === 'function') {
        try { entry.options.scrollToBottom(); } catch (e) { /* view already gone */ }
      }
    }

    function isTerminal() {
      return entry.state === 'submitted' || entry.state === 'closed';
    }

    function refreshPreview() {
      if (!isTerminal()) { previewEl.textContent = ''; return; }
      if (entry.state === 'submitted') {
        previewEl.textContent = questions.map(function (question) {
          return answerValue(question, answers.get(question.id));
        }).join(' · ');
      } else {
        previewEl.textContent = noteEl.textContent || IexaI18n.t('question.noAnswer');
      }
    }

    function applyCollapsed() {
      var collapsed = isTerminal() && entry.collapsed === true;
      root.classList.toggle('is-collapsed', collapsed);
      toggleBtn.setAttribute('aria-expanded', String(!collapsed));
      var label = collapsed ? IexaI18n.t('question.expandDetails') : IexaI18n.t('question.hideDetails');
      toggleBtn.title = label;
      toggleBtn.setAttribute('aria-label', label);
      previewEl.title = label;
      previewEl.hidden = !collapsed;
      // Folded, the head shows what the card actually asked — the title is the card's
      // own name and only returns when the full summary is open.
      titleEl.textContent = collapsed && questions[0] && questions[0].question
        ? String(questions[0].question)
        : titleText;
      var showMore = collapsed && questions.length > 1;
      if (showMore) qmoreEl.textContent = IexaI18n.t('question.total', { count: questions.length });
      qmoreEl.hidden = !showMore;
      if (collapsed) {
        refreshPreview();
        var active = document.activeElement;
        if (active && root.contains(active) && typeof toggleBtn.focus === 'function') {
          try { toggleBtn.focus({ preventScroll: true }); } catch (e) { /* older engines */ }
        }
      }
    }

    function setCollapsed(collapsed) {
      entry.collapsed = collapsed === true;
      applyCollapsed();
    }

    function setState(state, message) {
      entry.state = state;
      root.dataset.state = state;
      root.classList.toggle('is-final', state !== 'awaiting' && state !== 'submitting');
      if (state === 'submitted' || state === 'closed') entry.collapsed = true;
      applyCollapsed();
    }

    function finalize(target, state, message) {
      if (target.state === 'submitted' || target.state === 'closed') return;
      if (target.timer) { clearTimeout(target.timer); target.timer = undefined; }
      setState(state, message);
      renderSummary(message);
    }

    function advance() {
      if (index < questions.length - 1) {
        index += 1;
        renderQuestion();
        focusCurrent();
      } else {
        void submit();
      }
    }

    function focusCurrent() {
      if (!root.isConnected) return;
      var target = bodyEl.querySelector('.question-free-input') || bodyEl.querySelector('.question-option') || nextBtn;
      if (target && typeof target.focus === 'function') { try { target.focus({ preventScroll: true }); } catch (e) { /* older engines */ } }
    }

    async function submit() {
      if (entry.state !== 'awaiting' || !allSettled()) return;
      setState('submitting');
      noteEl.hidden = false;
      noteEl.textContent = IexaI18n.t('question.submitting');
      syncActions();
      var payload = {
        id: entry.id,
        answers: questions.map(function (question) {
          var record = answers.get(question.id);
          var free = String(record.freeText || '').trim();
          return { id: question.id, selected: record.selected.slice(), freeText: free || undefined, skipped: record.skipped === true };
        }),
      };
      try {
        await window.IexaApi.json((entry.options.apiBase || '') + '/api/questions/answer', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
        setState('submitted');
        renderSummary(IexaI18n.t('question.submitted'));
      } catch (error) {
        var message = String((error && error.message) || error || '');
        if (message.indexOf('不存在') !== -1 || message.indexOf('已结束') !== -1) { // i18n-exempt: matches server error text
          finalize(entry, 'closed', IexaI18n.t('question.endedSubmit'));
          return;
        }
        setState('awaiting');
        noteEl.textContent = IexaI18n.t('question.submitFailed');
        syncActions();
        if (typeof entry.options.onError === 'function') entry.options.onError(IexaI18n.t('question.submitFailedPrefix') + (message || IexaI18n.t('common.unknownError')));
      }
    }

    async function cancelRequest() {
      if (entry.state !== 'awaiting') return;
      var confirmed = true;
      if (window.IexaDialogs && typeof window.IexaDialogs.confirm === 'function') {
        try { confirmed = await window.IexaDialogs.confirm(IexaI18n.t('question.confirmCancel')); } catch (e) { confirmed = false; }
      }
      if (!confirmed || entry.state !== 'awaiting') return;
      closeBtn.disabled = true;
      try {
        await window.IexaApi.json((entry.options.apiBase || '') + '/api/questions/cancel', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: entry.id }),
        });
        finalize(entry, 'closed', IexaI18n.t('question.cancelled'));
      } catch (error) {
        var message = String((error && error.message) || error || '');
        if (message.indexOf('不存在') !== -1 || message.indexOf('已结束') !== -1) { // i18n-exempt: matches server error text
          finalize(entry, 'closed', IexaI18n.t('question.ended'));
          return;
        }
        closeBtn.disabled = false;
        noteEl.hidden = false;
        noteEl.textContent = IexaI18n.t('question.cancelFailed');
      }
    }

    backBtn.addEventListener('click', function (event) {
      event.preventDefault(); event.stopPropagation();
      if (entry.state !== 'awaiting' || index === 0) return;
      index -= 1;
      renderQuestion();
      focusCurrent();
    });
    skipBtn.addEventListener('click', function (event) {
      event.preventDefault(); event.stopPropagation();
      if (entry.state !== 'awaiting') return;
      var record = currentAnswer();
      record.skipped = true;
      record.selected = [];
      record.freeText = '';
      if (index < questions.length - 1) { index += 1; renderQuestion(); focusCurrent(); }
      else { renderQuestion(); syncActions(); }
    });
    nextBtn.addEventListener('click', function (event) {
      event.preventDefault(); event.stopPropagation();
      if (entry.state !== 'awaiting' || nextBtn.disabled) return;
      advance();
    });
    closeBtn.addEventListener('click', function (event) {
      event.preventDefault(); event.stopPropagation();
      void cancelRequest();
    });
    toggleBtn.addEventListener('click', function (event) {
      event.preventDefault(); event.stopPropagation();
      if (!isTerminal()) return;
      setCollapsed(entry.collapsed !== true);
    });
    previewEl.addEventListener('click', function () {
      if (!isTerminal() || entry.collapsed !== true) return;
      setCollapsed(false);
    });

    root.addEventListener('keydown', function (event) {
      if (entry.state !== 'awaiting') return;
      var tag = (event.target && event.target.tagName) || '';
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (/^[1-9]$/.test(event.key)) {
        var optionButtons = bodyEl.querySelectorAll('.question-option');
        var target = optionButtons[Number(event.key) - 1];
        if (target) { event.preventDefault(); target.click(); }
      }
    });

    if (data.expiresAt && Number.isFinite(Number(data.expiresAt))) {
      entry.timer = setTimeout(function () {
        if (entry.state === 'awaiting') finalize(entry, 'closed', IexaI18n.t('question.timedOut'));
      }, Math.min(2147483647, Math.max(0, Number(data.expiresAt) - Date.now())));
    }

    renderQuestion();
    return entry;
  }

  function show(data, options) {
    options = options || {};
    if (!data || !data.id) return null;
    var existing = cards.get(String(data.id));
    if (existing) { existing.reveal(); return existing; }
    var entry = createEntry(data, options);
    if (!entry) return null;
    cards.set(entry.id, entry);
    try {
      if (typeof options.mount === 'function') options.mount(entry.el, data);
      else document.body.appendChild(entry.el);
    } catch (error) {
      /* Mounting must never trap the answer flow; the card still works from the map. */
    }
    entry.reveal();
    if (entry.el.isConnected) {
      var first = entry.el.querySelector('.question-free-input') || entry.el.querySelector('.question-option') || entry.el.querySelector('.question-nav');
      if (first && typeof first.focus === 'function') { try { first.focus({ preventScroll: true }); } catch (e) { /* older engines */ } }
    }
    return entry;
  }

  function forToolCall(toolCallId) {
    if (!toolCallId) return [];
    var key = String(toolCallId);
    var found = [];
    for (var pair of cards) if (pair[1].toolCallId === key) found.push(pair[1]);
    return found;
  }

  async function syncPending(sessionId, options) {
    options = options || {};
    if (!sessionId || !window.IexaApi || typeof window.IexaApi.json !== 'function') return;
    var data;
    try {
      data = await window.IexaApi.json((options.apiBase || '') + '/api/questions?sessionId=' + encodeURIComponent(sessionId));
    } catch (error) {
      return; // SSE remains the primary transport; a failed reconcile is silent.
    }
    var list = Array.isArray(data && data.questions) ? data.questions : [];
    var current = new Set(list.map(function (item) { return String(item.id); }));
    for (var pair of Array.from(cards)) {
      var entry = pair[1];
      if (entry.sessionId === String(sessionId) && entry.state === 'awaiting' && !current.has(entry.id)) {
        entry.expire(IexaI18n.t('question.endedNoAnswer'));
      }
    }
    if (typeof options.isCurrent === 'function' && !options.isCurrent()) return;
    for (var item of list) {
      if (!cards.has(String(item.id))) show(item, options);
    }
  }

  function applyToolState(toolCallId, status) {
    if (!TOOL_TERMINAL[status]) return;
    for (var entry of forToolCall(toolCallId)) {
      if (entry.state !== 'awaiting') continue;
      if (status === 'cancelled') entry.interrupt(IexaI18n.t('question.taskStopped'));
      else if (status === 'timed_out') entry.expire(IexaI18n.t('question.timedOut'));
      else if (status === 'completed') entry.complete(IexaI18n.t('question.handled'));
      else entry.expire(IexaI18n.t('question.endedNoReply'));
    }
  }

  function completeForResult(toolCallId, result) {
    var status = result && result.executionStatus;
    if (!status) status = result && result.success === true ? 'completed' : undefined;
    if (status) applyToolState(toolCallId, status);
  }

  function disableForSession(sessionId, reason) {
    if (!sessionId) return;
    for (var entry of cards.values()) {
      if (entry.sessionId === String(sessionId) && entry.state === 'awaiting') {
        entry.interrupt(reason === 'cancelled' ? IexaI18n.t('question.turnStopped') : IexaI18n.t('question.endedNoReply'));
      }
    }
  }

  function close(id) {
    var entry = cards.get(String(id));
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.el.remove();
    cards.delete(String(id));
  }

  window.IexaQuestionCard = {
    show: show,
    syncPending: syncPending,
    applyToolState: applyToolState,
    completeForResult: completeForResult,
    disableForSession: disableForSession,
    close: close,
    _count: function () { return cards.size; },
  };
}());
