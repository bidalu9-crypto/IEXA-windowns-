'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform, Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { electronVersion, runtimeDir, assertInside, root } = require('./scripts/electron-config.cjs');
function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject); input.on('data', x => hash.update(x));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}
function expectedChecksum(sums, filename) {
  const matches = String(sums).split(/\r?\n/).map(line => line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i))
    .filter(match => match && match[2] === filename);
  if (matches.length !== 1) throw Error(`Expected exactly one official SHA256 for ${filename}`);
  return matches[0][1].toLowerCase();
}
async function response(url, redirects = 0) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || redirects > 5) throw Error('Insecure URL or excessive redirects');
  const res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(180_000),
    headers: { 'User-Agent': 'IEXA-runtime-verifier' } });
  if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
    await res.body.cancel();
    return response(new URL(res.headers.get('location'), target), redirects + 1);
  }
  if (res.status !== 200) { await res.body.cancel(); throw Error(`HTTP ${res.status}: ${target}`); }
  return res;
}
async function download(url, dest, limit) {
  const temp = `${dest}.${process.pid}.download`;
  try {
    const res = await response(url);
    let size = 0;
    const limiter = new Transform({ transform(chunk, encoding, done) {
      size += chunk.length; done(size > limit ? Error('Download size limit exceeded') : null, chunk);
    } });
    console.log(`Downloading ${path.basename(dest)}`);
    await pipeline(Readable.fromWeb(res.body), limiter, fs.createWriteStream(temp, { flags: 'wx' }));
    if (res.headers.get('content-length') && size !== Number(res.headers.get('content-length'))) throw Error('Incomplete Electron download');
    fs.renameSync(temp, dest);
  } finally { fs.rmSync(temp, { force: true }); }
}
async function verifyArchive(file, expected) {
  const actual = await sha256(file);
  if (actual !== expected) throw Error(`Electron SHA256 mismatch: expected ${expected}, got ${actual}`);
  return actual;
}
async function fileHashes(dir) {
  const hashes = {};
  async function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw Error('Unexpected symlink in Electron runtime');
      if (entry.isDirectory()) await visit(file);
      else if (entry.name !== '.iexa-verified.json') hashes[path.relative(dir, file).replace(/\\/g, '/')] = await sha256(file);
    }
  }
  await visit(dir); return hashes;
}
async function installRuntime(archive, expected, sumsURL) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('This distribution targets Windows x64');
  const destination = assertInside(path.join(root, 'node_modules/electron'), runtimeDir());
  const marker = path.join(destination, '.iexa-verified.json');
  if (fs.existsSync(marker)) {
    const old = JSON.parse(fs.readFileSync(marker));
    if (old.version === electronVersion() && old.archiveSHA256 === expected &&
        JSON.stringify(old.files) === JSON.stringify(await fileHashes(destination))) {
      fs.writeFileSync(path.join(root, 'node_modules/electron/path.txt'), 'electron.exe');
      console.log(`Verified installed Electron ${electronVersion()}`); return;
    }
  }
  const staging = assertInside(path.join(root, 'node_modules/electron'), `${destination}.verified-${process.pid}`);
  if (fs.existsSync(staging)) throw Error(`Staging path already exists: ${staging}`);
  try {
    // Environment variables carry literal paths, never shell-composed path expressions.
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:IEXA_ARCHIVE -DestinationPath $env:IEXA_EXTRACT"],
      { windowsHide: true, stdio: 'inherit', env: { ...process.env, IEXA_ARCHIVE: archive, IEXA_EXTRACT: staging } });
    if (result.error || result.status !== 0) throw result.error || Error('Electron extraction failed');
    for (const required of ['electron.exe', 'resources/default_app.asar', 'locales/en-US.pak', 'icudtl.dat']) {
      if (!fs.existsSync(path.join(staging, required))) throw Error(`Incomplete Electron archive: ${required}`);
    }
    // Verify the executable's own version before promoting the staging tree.
    const probe = spawnSync(path.join(staging, 'electron.exe'), ['-p', 'process.versions.electron'], {
      windowsHide: true, encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    if (probe.status !== 0 || probe.stdout.trim() !== electronVersion()) throw Error(`Electron version probe failed: ${probe.stderr || probe.stdout}`);
    const manifest = { version: electronVersion(), archiveSHA256: expected, sumsURL, files: await fileHashes(staging) };
    fs.writeFileSync(path.join(staging, '.iexa-verified.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
    fs.writeFileSync(path.join(root, 'node_modules/electron/path.txt'), 'electron.exe');
    console.log(`Installed verified Electron ${electronVersion()}: ${destination}`);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
async function main() {
  const version = electronVersion();
  const cache = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'IEXA/electron-cache');
  fs.mkdirSync(cache, { recursive: true });
  const name = `electron-v${version}-win32-x64.zip`;
  const base = `https://github.com/electron/electron/releases/download/v${version}/`;
  const sumsURL = `${base}SHASUMS256.txt`;
  const sums = path.join(cache, `SHASUMS256-${version}.txt`);
  // The checksum trust root is always the official release, never a binary mirror.
  await download(sumsURL, sums, 1024 * 1024);
  const expected = expectedChecksum(fs.readFileSync(sums, 'utf8'), name);
  const archive = path.join(cache, name);
  if (fs.existsSync(archive) && await sha256(archive) !== expected) fs.rmSync(archive);
  if (!fs.existsSync(archive)) {
    if (process.argv.includes('--ranged')) await require('./scripts/download-ranged.cjs').downloadRanged(`${base}${name}`, archive);
    else {
      try { await download(`${base}${name}`, archive, 600 * 1024 * 1024); }
      catch (error) {
        console.warn(`Full Electron transfer failed (${error.message}); trying bounded ranges once.`);
        await require('./scripts/download-ranged.cjs').downloadRanged(`${base}${name}`, archive);
      }
    }
  }
  try { await verifyArchive(archive, expected); }
  catch (error) { fs.rmSync(archive, { force: true }); throw error; }
  console.log(`SHA256 verified ${name}: ${expected}`);
  if (process.argv.includes('--install')) await installRuntime(archive, expected, sumsURL);
  return archive;
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { expectedChecksum, verifyArchive, sha256, fileHashes, main };
