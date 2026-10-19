// The renderer is a set of classic scripts that share one global scope, so a
// function's home file is an implementation detail. Tests that inspect source
// text should read this bundle instead of app.js: it concatenates every script
// in index.html order, which is also the order the browser evaluates them.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src/renderer');

const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
const files = [];
for (const match of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
  const src = match[1];
  if (/^vendor\//.test(src)) continue;
  files.push(src);
}
if (!files.length) throw new Error('no renderer scripts found in index.html');
if (files.filter((src) => src === 'app.js').length !== 1) throw new Error('app.js must be loaded exactly once');

// Two chrome helpers deliberately run after app.js: they decorate a finished
// application rather than define anything app.js needs at load time.
const TRAILING = new Set(['services/WorkbenchShell.js', 'services/WindowChrome.js']);
const appIndex = files.indexOf('app.js');
for (const src of files) {
  if (src === 'app.js' || TRAILING.has(src)) continue;
  if (files.indexOf(src) > appIndex) throw new Error('script must load before app.js: ' + src);
}
for (const src of TRAILING) {
  if (files.includes(src) && files.indexOf(src) < appIndex) throw new Error('chrome helper must load after app.js: ' + src);
}

const parts = files.map((src) => {
  const full = path.join(RENDERER, src);
  if (!fs.existsSync(full)) throw new Error('script listed in index.html is missing: ' + src);
  return { src, text: fs.readFileSync(full, 'utf8') };
});

// Normalise newlines so offset-based slicing in tests behaves the same on every
// checkout, then join with a blank line to keep line numbers unambiguous.
const source = parts.map((p) => p.text.replace(/\r\n/g, '\n')).join('\n');

module.exports = {
  files,
  parts,
  source,
  /** Read one renderer script, failing loudly when the path is wrong. */
  read(src) {
    const found = parts.find((p) => p.src === src);
    if (!found) throw new Error('script not loaded by index.html: ' + src);
    return found.text;
  },
};
