'use strict';
// Renderer modules call IexaI18n.t() at render time, so any test that evals a
// subset of the classic scripts has to install the i18n layer first — exactly
// like index.html does. Without it the first translated string throws.
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');

module.exports = function installI18n(win) {
  if (win.IexaI18n) return win.IexaI18n;
  for (const file of ['services/I18nUi.js', 'services/I18n.js']) {
    win.eval(fs.readFileSync(path.join(RENDERER, file), 'utf8'));
  }
  return win.IexaI18n;
};
