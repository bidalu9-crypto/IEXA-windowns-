// Deterministic browser assets copied from exact, lockfile-verified npm packages.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const out = path.join(root, 'src/renderer/vendor');
const assets = [
  ['dompurify', 'dist/purify.min.js', 'purify.min.js'],
  ['dompurify', 'LICENSE', 'DOMPurify-LICENSE'],
  ['marked', 'lib/marked.umd.js', 'marked.umd.js'],
  ['marked', 'LICENSE', 'marked-LICENSE'],
  ['@highlightjs/cdn-assets', 'highlight.min.js', 'highlight.min.js'],
  ['@highlightjs/cdn-assets', 'styles/github.min.css', 'github.min.css'],
  ['@highlightjs/cdn-assets', 'styles/github-dark.min.css', 'github-dark.min.css'],
  ['highlight.js', 'LICENSE', 'highlightjs-LICENSE'],
];
function vendor(check = false) {
  const manifest = {};
  for (const [name, source, target] of assets) {
    const dir = path.join(root, 'node_modules', name);
    const installed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).version;
    const pinned = pkg.dependencies[name] || pkg.devDependencies[name];
    if (installed !== pinned || !/^\d+\.\d+\.\d+$/.test(pinned)) throw Error(`Unpinned/mismatched ${name}: ${installed} vs ${pinned}`);
    if (name === '@highlightjs/cdn-assets' && installed !== pkg.dependencies['highlight.js']) throw Error('Highlight browser and Node versions differ');
    const bytes = fs.readFileSync(path.join(dir, source));
    manifest[target] = { package: name, version: installed, source, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    const dest = path.join(out, target);
    if (check) {
      if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(bytes)) throw Error(`Stale renderer asset: ${target}`);
    } else {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(dest, bytes);
    }
  }
  const text = JSON.stringify(manifest, null, 2) + '\n';
  const dest = path.join(out, 'manifest.json');
  if (check) {
    if (fs.readFileSync(dest, 'utf8') !== text) throw Error('Stale renderer manifest');
  } else fs.writeFileSync(dest, text);
  console.log(`Renderer assets ${check ? 'verified' : 'vendored'} (${assets.length})`);
}
if (require.main === module) vendor(process.argv.includes('--check'));
module.exports = { vendor };
