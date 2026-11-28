/* Display-only phrase filter.
 *
 * The user keeps a plain text list at src/renderer/non-display.txt. Any phrase
 * on that list is stripped from what the chat renders - both the standard
 * transcript and natural chat - while everything around it stays.
 *
 * Two rules make this predictable:
 *   1. A phrase is removed only when it appears in full. A partial fragment is
 *      left untouched, so the list can never eat a sentence by accident.
 *   2. This never touches stored content. The message on disk keeps every word;
 *      only the painted HTML loses the phrase. Reopening a conversation later
 *      still filters, because the filter runs at render time.
 */
(function () {
  'use strict';

  const SOURCE = 'non-display.txt';
  let phrases = [];
  let loaded = false;

  /** Parse one line-per-phrase, skipping blanks and # comments. */
  function parse(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      // Longest first: removing the specific line before a shorter one that it
      // contains keeps the remaining text coherent.
      .sort((a, b) => b.length - a.length);
  }

  /** Remove every fully-present phrase; partial matches stay as they are. */
  function filter(text) {
    const value = String(text || '');
    if (!loaded || !phrases.length || !value) return value;
    let out = value;
    for (const phrase of phrases) {
      if (out.includes(phrase)) out = out.split(phrase).join('');
    }
    return out;
  }

  /**
   * True when filtering leaves nothing worth showing.
   *
   * Blank input is NOT empty: every assistant bubble starts life with no text
   * while it streams, and treating that as "filtered away" hid the whole reply
   * the moment the list had any entry in it.
   */
  function isEmpty(text) {
    if (!loaded || !phrases.length) return false;
    const value = String(text || '');
    if (!value.trim()) return false;
    return !filter(value).trim();
  }

  const ready = fetch(SOURCE, { cache: 'no-cache' })
    .then((response) => (response.ok ? response.text() : ''))
    .then((text) => {
      phrases = parse(text);
      loaded = true;
      return phrases;
    })
    .catch(() => {
      loaded = true;
      return [];
    });

  globalThis.IexaNonDisplay = {
    filter,
    isEmpty,
    ready,
    list: () => phrases.slice(),
    reload: () => fetch(SOURCE, { cache: 'no-cache' })
      .then((response) => (response.ok ? response.text() : ''))
      .then((text) => { phrases = parse(text); loaded = true; return phrases; }),
  };
})();
