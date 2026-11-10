'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const DEST = path.join(ROOT, 'resources/language-services/pyright');
const VERSION = '1.1.402';
const URL = `https://open-vsx.org/api/ms-pyright/pyright/${VERSION}/file/ms-pyright.pyright-${VERSION}.vsix`;
const SHA256 = '7ffa5a8649fa800b282c25ad70ce290367e036238d52727da7cdcac3d57439e9';
const CACHE = path.join(ROOT, '.iexa-artifacts', 'python-language-vendor');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fileRecords(base) {
  const result = [];
  function walk(relative = '') {
    for (const item of fs.readdirSync(path.join(base, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const rel = path.posix.join(relative, item.name);
      if (rel === 'vendor-manifest.json') continue;
      if (item.isSymbolicLink()) throw Error('Unexpected link: ' + rel);
      if (item.isDirectory()) walk(rel);
      else { const bytes = fs.readFileSync(path.join(base, rel)); result.push({ path: rel, bytes: bytes.length, sha256: hash(bytes) }); }
    }
  }
  walk(); return result;
}
function manifest(base) {
  return { schemaVersion: 1, name: 'pyright', version: VERSION, license: 'MIT', source: { url: URL, sha256: SHA256 }, entry: 'dist/server.js', files: fileRecords(base) };
}
function check(base = DEST) {
  const saved = JSON.parse(fs.readFileSync(path.join(base, 'vendor-manifest.json'), 'utf8'));
  if (saved.version !== VERSION || saved.license !== 'MIT' || saved.source?.sha256 !== SHA256 || saved.source?.url !== URL || saved.entry !== 'dist/server.js') throw Error('Pyright manifest identity mismatch');
  const actual = fileRecords(base), ordered = [...saved.files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (JSON.stringify(actual.sort((a, b) => a.path.localeCompare(b.path, 'en'))) !== JSON.stringify(ordered)) throw Error('Pyright files differ from pinned manifest; run node scripts/vendor-python-language.cjs');
  if (!/MIT License/.test(fs.readFileSync(path.join(base, 'LICENSE.txt'), 'utf8'))) throw Error('Pyright MIT license missing');
  console.log(`Pyright ${VERSION} verified: ${actual.length} original files, ${actual.reduce((sum, item) => sum + item.bytes, 0)} bytes`);
}
async function install() {
  fs.mkdirSync(CACHE, { recursive: true });
  const flag = process.argv.indexOf('--archive');
  let archive = flag >= 0 ? path.resolve(process.argv[flag + 1] || '') : path.join(CACHE, `ms-pyright.pyright-${VERSION}.vsix`);
  if (flag < 0 && !fs.existsSync(archive)) {
    const oldCache = path.join(ROOT, '.iexa-artifacts/codeoss-evaluation-20261108', path.basename(archive));
    if (fs.existsSync(oldCache) && hash(fs.readFileSync(oldCache)) === SHA256) fs.copyFileSync(oldCache, archive);
    else {
      const response = await fetch(URL, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw Error('Pyright download HTTP ' + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (hash(bytes) !== SHA256) throw Error('Pyright VSIX checksum mismatch');
      fs.writeFileSync(archive, bytes);
    }
  }
  if (hash(fs.readFileSync(archive)) !== SHA256) throw Error('Pyright VSIX checksum mismatch');
  const stage = fs.mkdtempSync(path.join(CACHE, 'stage-'));
  const script = String.raw`import pathlib,sys,zipfile
base=pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(sys.argv[1]) as bundle:
 for item in bundle.infolist():
  if item.is_dir() or not item.filename.startswith('extension/'): continue
  rel=pathlib.PurePosixPath(item.filename[len('extension/'):])
  name=str(rel)
  if name not in ('LICENSE.txt','package.json','dist/server.js','dist/server.js.LICENSE.txt') and not name.startswith('dist/typeshed-fallback/'): continue
  if rel.is_absolute() or '..' in rel.parts: raise ValueError('Invalid VSIX path')
  target=base.joinpath(*rel.parts)
  target.parent.mkdir(parents=True,exist_ok=True)
  target.write_bytes(bundle.read(item))
`;
  let previous;
  try {
    const extraction = spawnSync('python', ['-I', '-B', '-X', 'utf8', '-c', script, archive, stage], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    if (extraction.status !== 0) throw Error('Python is needed only to reproduce the original VSIX: ' + extraction.stderr);
    fs.writeFileSync(path.join(stage, 'vendor-manifest.json'), JSON.stringify(manifest(stage), null, 2) + '\n');
    check(stage);
    fs.mkdirSync(path.dirname(DEST), { recursive: true });
    if (fs.existsSync(DEST)) { previous = path.join(CACHE, `previous-${Date.now()}`); fs.renameSync(DEST, previous); }
    try { fs.renameSync(stage, DEST); } catch (error) { if (previous) fs.renameSync(previous, DEST); throw error; }
    console.log('Restored the standalone Pyright stdio server. No VS Code runtime or Node executable is copied.');
  } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); }
}
(async () => { if (process.argv.includes('--check')) check(); else await install(); })().catch(error => { console.error(error.message); process.exitCode = 1; });
