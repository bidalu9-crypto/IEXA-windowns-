'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..'), assets = path.join(root, 'src/renderer/vendor/file-icons');
const source = fs.readFileSync(path.join(root, 'src/renderer/services/IDEFileIcons.js'), 'utf8');
function fixture(t) { const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only', url: 'http://127.0.0.1:1234/' }); dom.window.eval(source); t.after(() => dom.window.close()); return dom.window; }
test('file-name and suffix precedence covers code, project metadata, config and binary file types', t => {
  const w = fixture(t), cases = {
    'main.py': 'python', 'test.pyi': 'python', 'main.js': 'javascript', 'main.cjs': 'javascript', 'main.mjs': 'javascript', 'main.ts': 'typescript', 'App.jsx': 'react', 'App.tsx': 'react_ts', 'App.vue': 'vue',
    'schema.json': 'json', 'package.json': 'nodejs', 'package-lock.json': 'npm', 'yarn.lock': 'yarn', 'pnpm-lock.yaml': 'pnpm', 'bun.lockb': 'bun', 'poetry.lock': 'poetry', 'uv.lock': 'uv',
    'tsconfig.json': 'tsconfig', 'tsconfig.app.json': 'tsconfig', 'types.d.ts': 'typescript-def', 'jsconfig.json': 'jsconfig', '.env': 'tune', '.env.production.local': 'tune', '.gitignore': 'git', '.gitattributes': 'git',
    '.eslintrc': 'eslint', '.eslintrc.json': 'eslint', 'eslint.config.mjs': 'eslint', '.prettierrc': 'prettier', 'prettier.config.js': 'prettier', '.prettierignore': 'prettier',
    'README': 'readme', 'readme.md': 'readme', 'guide.md': 'markdown', 'ci.yaml': 'yaml', 'config.yml': 'yaml', 'settings.toml': 'toml', 'pyproject.toml': 'python', 'Cargo.toml': 'rust',
    'index.html': 'html', 'style.css': 'css', 'style.scss': 'sass', 'style.sass': 'sass', 'Program.cs': 'csharp', 'App.csproj': 'csharp', 'app.sln': 'visualstudio', 'main.c': 'c', 'main.cpp': 'cpp', 'header.hpp': 'hpp',
    'main.go': 'go', 'go.mod': 'go-mod', 'lib.rs': 'rust', 'script.ps1': 'powershell', 'script.psm1': 'powershell', 'start.sh': 'console', 'setup.bat': 'console', 'Dockerfile': 'docker', 'Dockerfile.production': 'docker', '.dockerignore': 'docker',
    'docker-compose.yml': 'docker', 'CMakeLists.txt': 'cmake', 'project.cmake': 'cmake', 'Makefile': 'makefile', 'image.png': 'image', 'drawing.svg': 'svg', 'archive.zip': 'zip', 'archive.tar.gz': 'zip',
    'font.woff2': 'font', 'font.ttf': 'font', 'program.exe': 'exe', 'plugin.dll': 'dll', 'library.so': 'dll', 'library.lib': 'lib', 'object.bin': 'hex', 'module.wasm': 'webassembly', 'unknown.custom': 'document',
  };
  for (const [file, expected] of Object.entries(cases)) assert.equal(w.IexaIDEFileIcons.resolve(file), expected, file);
  assert.equal(w.IexaIDEFileIcons.resolve('C:\\项目\\MAIN.PY'), 'python'); assert.equal(w.IexaIDEFileIcons.resolve('src/组件/App.TSX'), 'react_ts');
});
test('named folders have distinct expanded assets and unknown folders have a generic open/closed fallback', t => {
  const w = fixture(t), cases = { src: 'folder-src', tests: 'folder-test', docs: 'folder-docs', assets: 'folder-resource', public: 'folder-public', node_modules: 'folder-node', '.github': 'folder-github', '.vscode': 'folder-vscode', images: 'folder-images', fonts: 'folder-font' };
  for (const [name, expected] of Object.entries(cases)) { assert.equal(w.IexaIDEFileIcons.resolve('project/' + name, { directory: true }), expected); assert.equal(w.IexaIDEFileIcons.resolve(name, { directory: true, expanded: true }), expected + '-open'); }
  assert.equal(w.IexaIDEFileIcons.resolve('unknown', { directory: true }), 'folder-base'); assert.equal(w.IexaIDEFileIcons.resolve('unknown', { directory: true, expanded: true }), 'folder-base-open');
});
test('the API creates fixed local decorative images with a bounded generic failure fallback', t => {
  const w = fixture(t), image = w.IexaIDEFileIcons.create('src/app.py');
  assert.equal(image.tagName, 'IMG'); assert.equal(image.className, 'ide-file-icon'); assert.equal(image.getAttribute('src'), 'vendor/file-icons/python.svg'); assert.equal(image.getAttribute('aria-hidden'), 'true'); assert.equal(image.alt, ''); assert.equal(image.width, 16); assert.equal(image.height, 16);
  image.dispatchEvent(new w.Event('error')); assert.equal(image.getAttribute('src'), 'vendor/file-icons/document.svg'); image.dispatchEvent(new w.Event('error')); assert.equal(image.getAttribute('src'), 'vendor/file-icons/document.svg');
  for (const value of ['https://evil.test/payload', '//evil.test/a.svg', 'data:image/svg+xml,<svg onload=alert(1)>', '../..//main.py', '<script>evil</script>', '__proto__', 'constructor', '', null]) {
    const icon = w.IexaIDEFileIcons.create(value); assert.match(icon.getAttribute('src'), /^vendor\/file-icons\/[a-z0-9_-]+\.svg$/); assert.ok(w.IexaIDEFileIcons.assets.includes(icon.dataset.fileIcon));
  }
});
test('every statically mapped asset is local, pinned by SHA256 and carries the official MIT license', t => {
  const w = fixture(t), manifest = JSON.parse(fs.readFileSync(path.join(assets, 'source-manifest.json'), 'utf8'));
  assert.equal(manifest.commit, 'ced21b9b5241c1efa502a8c46ec7363a690a7058'); assert.equal(manifest.license, 'MIT'); assert.match(fs.readFileSync(path.join(assets, 'LICENSE'), 'utf8'), /MIT License/);
  const records = new Map(manifest.assets.map(record => [record.path, record]));
  for (const name of w.IexaIDEFileIcons.assets) {
    const file = name + '.svg', data = fs.readFileSync(path.join(assets, file)), record = records.get(file); assert.ok(record, 'manifest: ' + file); assert.equal(crypto.createHash('sha256').update(data).digest('hex'), record.sha256, file);
    const svg = new w.DOMParser().parseFromString(data.toString('utf8'), 'image/svg+xml'); assert.equal(svg.documentElement.localName, 'svg', file); assert.equal(svg.querySelector('parsererror'), null, file);
    assert.equal(svg.querySelector('script,foreignObject,iframe,image,use,style'), null, file);
    for (const node of svg.querySelectorAll('*')) for (const attribute of node.attributes) { assert.ok(!/^on/i.test(attribute.name), file + ' event handler'); if (/href$/i.test(attribute.name)) assert.ok(attribute.value.startsWith('#'), file + ' external reference'); }
  }
});
test('open folder assets use the official generator path and preserve each named motive', t => {
  const w = fixture(t), generator = fs.readFileSync(path.join(assets, 'generateOpenFolderIcons.ts'), 'utf8');
  const officialPath = generator.match(/const OPEN_FOLDER_PATH\s*=\s*'([^']+)'/)[1];
  for (const name of w.IexaIDEFileIcons.assets.filter(name => name.endsWith('-open'))) {
    const closed = new w.DOMParser().parseFromString(fs.readFileSync(path.join(assets, name.replace(/-open$/, '') + '.svg'), 'utf8'), 'image/svg+xml');
    const opened = new w.DOMParser().parseFromString(fs.readFileSync(path.join(assets, name + '.svg'), 'utf8'), 'image/svg+xml');
    assert.equal(opened.querySelector('#folder').getAttribute('d'), officialPath, name); assert.notEqual(closed.querySelector('#folder').getAttribute('d'), officialPath, name); assert.equal(opened.querySelector('#motive')?.outerHTML, closed.querySelector('#motive')?.outerHTML, name + ' motive preserved');
  }
});
