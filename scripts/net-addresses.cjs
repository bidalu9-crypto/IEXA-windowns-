// Print the three values the launcher banner needs, as `KEY=value` lines:
//
//   IEXA_V4     this machine's LAN IPv4, or `unavailable`
//   IEXA_V6     an IPv6 global address, or empty
//   IEXA_STALE  1 when src\ is newer than dist\main\server.js
//
// Replaces a `powershell -NoProfile -Command "...Get-NetIPAddress..."` in the
// .bat files. That call costs ~1.4 s on a cold start, which was most of the
// wait before the server even began loading; node is already a hard dependency
// here and starts in ~55 ms. Output uses `KEY=value` rather than two tokens so
// an absent IPv6 does not shift the fields.
//
// Prefix origin is not exposed by os.networkInterfaces(), so the picks are
// heuristics: a private IPv4 first (that is the LAN one DHCP hands out),
// then any IPv4; for IPv6 a global unicast (2xxx/3xxx) before anything else,
// skipping link-local and loopback. The .bat files fall back to the old
// PowerShell lookup when this file or node is missing.
const fs = require('fs');
const os = require('os');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');

function addresses() {
  const v4 = [];
  const v6 = [];
  let interfaces = {};
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return { v4: '', v6: '' };
  }
  for (const list of Object.values(interfaces)) {
    for (const info of list || []) {
      if (!info || info.internal) continue;
      const family = String(info.family);
      const address = String(info.address || '');
      if (!address) continue;
      if (family === 'IPv4' || family === '4') { v4.push(address); continue; }
      if (family !== 'IPv6' && family !== '6') continue;
      if (address.startsWith('fe80') || address === '::1') continue;
      v6.push(address.split('%')[0]);
    }
  }
  const privateV4 = (value) => value.startsWith('192.168.')
    || value.startsWith('10.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(value);
  return {
    v4: v4.find(privateV4) || v4[0] || '',
    v6: v6.find((value) => /^[23]/.test(value)) || v6[0] || '',
  };
}

function newestSource() {
  let newest = 0;
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|js)$/.test(entry.name)) continue;
      try {
        const stamp = fs.statSync(full).mtimeMs;
        if (stamp > newest) newest = stamp;
      } catch { /* raced with an editor write */ }
    }
  };
  walk(path.join(appRoot, 'src'));
  return newest;
}

function stale() {
  try {
    const built = fs.statSync(path.join(appRoot, 'dist', 'main', 'server.js')).mtimeMs;
    return newestSource() > built ? 1 : 0;
  } catch {
    return 0;
  }
}

const found = addresses();
process.stdout.write(`IEXA_V4=${found.v4 || 'unavailable'}\r\n`);
process.stdout.write(`IEXA_V6=${found.v6}\r\n`);
process.stdout.write(`IEXA_STALE=${stale()}\r\n`);
