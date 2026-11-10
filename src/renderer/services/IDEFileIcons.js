// Offline Material Icon Theme assets, pinned and attributed in vendor/file-icons.
// Only static icon names below are ever used as a URL; project names are data.
(function (root) {
  'use strict';
  const extensions = Object.freeze({
    py: 'python', pyw: 'python', pyi: 'python', ipynb: 'python-misc',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', jsx: 'react', tsx: 'react_ts', vue: 'vue',
    json: 'json', jsonc: 'json', json5: 'json', md: 'markdown', markdown: 'markdown', mdx: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    html: 'html', htm: 'html', css: 'css', scss: 'sass', sass: 'sass', less: 'css',
    cs: 'csharp', csx: 'csharp', csproj: 'csharp', sln: 'visualstudio', slnx: 'visualstudio',
    c: 'c', h: 'h', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'hpp', hh: 'hpp', hxx: 'hpp',
    go: 'go', rs: 'rust', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', sh: 'console', bash: 'console', zsh: 'console', fish: 'console', bat: 'console', cmd: 'console',
    dockerfile: 'docker', cmake: 'cmake', svg: 'svg', svgz: 'svg', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image', ico: 'image', avif: 'image', heic: 'image', tiff: 'image',
    zip: 'zip', '7z': 'zip', rar: 'zip', tar: 'zip', gz: 'zip', bz2: 'zip', xz: 'zip', tgz: 'zip', woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', eot: 'font',
    exe: 'exe', msi: 'exe', dll: 'dll', so: 'dll', dylib: 'dll', a: 'lib', lib: 'lib', o: 'hex', obj: 'hex', bin: 'hex', dat: 'hex', wasm: 'webassembly',
    xml: 'xml', config: 'settings', ini: 'settings', cfg: 'settings', lock: 'lock', txt: 'document', log: 'log', pdf: 'pdf',
  });
  const names = Object.freeze({
    'package.json': 'nodejs', 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', '.npmrc': 'npm', '.npmignore': 'npm',
    'yarn.lock': 'yarn', '.yarnrc': 'yarn', '.yarnrc.yml': 'yarn', 'pnpm-lock.yaml': 'pnpm', 'pnpm-workspace.yaml': 'pnpm', 'bun.lock': 'bun', 'bun.lockb': 'bun',
    'poetry.lock': 'poetry', 'uv.lock': 'uv', 'pipfile': 'python', 'pipfile.lock': 'lock', 'requirements.txt': 'python', 'pyproject.toml': 'python', 'setup.py': 'python', 'setup.cfg': 'python',
    'cargo.toml': 'rust', 'cargo.lock': 'rust', 'go.mod': 'go-mod', 'go.sum': 'go-mod',
    '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git', '.gitkeep': 'git', '.gitconfig': 'git',
    '.editorconfig': 'editorconfig', '.prettierignore': 'prettier', '.eslintignore': 'eslint',
    'cmakelists.txt': 'cmake', 'makefile': 'makefile', 'gnumakefile': 'makefile', 'dockerfile': 'docker', '.dockerignore': 'docker', 'compose.yaml': 'docker', 'compose.yml': 'docker', 'docker-compose.yml': 'docker', 'docker-compose.yaml': 'docker',
    'license': 'license', 'license.md': 'license', 'license.txt': 'license', 'copying': 'license',
  });
  const folders = Object.freeze({
    src: 'folder-src', source: 'folder-src', sources: 'folder-src', test: 'folder-test', tests: 'folder-test', __tests__: 'folder-test', spec: 'folder-test', specs: 'folder-test',
    doc: 'folder-docs', docs: 'folder-docs', documentation: 'folder-docs', assets: 'folder-resource', resources: 'folder-resource', resource: 'folder-resource',
    public: 'folder-public', static: 'folder-public', node_modules: 'folder-node', '.github': 'folder-github', '.git': 'folder-git', '.vscode': 'folder-vscode',
    images: 'folder-images', image: 'folder-images', img: 'folder-images', fonts: 'folder-font', components: 'folder-components', config: 'folder-config', scripts: 'folder-scripts', dist: 'folder-dist', build: 'folder-dist',
  });
  function resolve(path, options = {}) {
    const value = typeof path === 'string' ? path : '', filename = value.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop().toLowerCase();
    if (options.directory) return (Object.prototype.hasOwnProperty.call(folders, filename) ? folders[filename] : 'folder-base') + (options.expanded ? '-open' : '');
    if (Object.prototype.hasOwnProperty.call(names, filename)) return names[filename];
    if (/^readme(?:\.|$)/.test(filename)) return 'readme';
    if (/^tsconfig(?:\.[^/]*)?\.json$/.test(filename)) return 'tsconfig';
    if (/^jsconfig(?:\.[^/]*)?\.json$/.test(filename)) return 'jsconfig';
    if (filename === '.env' || filename.startsWith('.env.')) return 'tune';
    if (/^(?:\.eslintrc(?:\.|$)|eslint\.config\.)/.test(filename)) return 'eslint';
    if (/^(?:\.prettierrc(?:\.|$)|prettier\.config\.)/.test(filename)) return 'prettier';
    if (/^(?:dockerfile\.|.+\.dockerfile$)/.test(filename)) return 'docker';
    if (/\.d\.(?:ts|mts|cts)$/.test(filename)) return 'typescript-def';
    const extension = filename.split('.').pop();
    return Object.prototype.hasOwnProperty.call(extensions, extension) ? extensions[extension] : 'document';
  }
  function create(path, options = {}) {
    const icon = resolve(path, options), image = root.document.createElement('img');
    image.className = 'ide-file-icon'; image.setAttribute('src', 'vendor/file-icons/' + icon + '.svg'); image.setAttribute('alt', ''); image.setAttribute('aria-hidden', 'true'); image.setAttribute('draggable', 'false'); image.width = 16; image.height = 16; image.decoding = 'async'; image.dataset.fileIcon = icon;
    image.addEventListener('error', () => { if (image.dataset.fileIcon === 'document') return; image.dataset.fileIcon = 'document'; image.setAttribute('src', 'vendor/file-icons/document.svg'); }, { once: true });
    return image;
  }
  const assets = Object.freeze([...new Set([...Object.values(extensions), ...Object.values(names), 'readme', 'tsconfig', 'jsconfig', 'tune', 'typescript-def', 'document', ...Object.values(folders), 'folder-base', ...[...Object.values(folders), 'folder-base'].map(name => name + '-open')])].sort());
  root.IexaIDEFileIcons = Object.freeze({ create, resolve, assets });
})(typeof window === 'undefined' ? globalThis : window);
