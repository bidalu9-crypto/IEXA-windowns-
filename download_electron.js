const https = require('https');
const fs = require('fs');
const path = require('path');

const version = '28.0.0';
const cacheDir = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache');
const zipName = `electron-v${version}-win32-x64.zip`;
const destPath = path.join(cacheDir, zipName);

// Ensure cache dir exists
fs.mkdirSync(cacheDir, { recursive: true });

console.log('Cache dir:', cacheDir);
console.log('Downloading:', zipName);
console.log('From: https://cdn.npmmirror.com/binaries/electron/' + version + '/' + zipName);

const url = `https://cdn.npmmirror.com/binaries/electron/${version}/${zipName}`;

https.get(url, (res) => {
  if (res.statusCode === 302 || res.statusCode === 301) {
    console.log('Following redirect to:', res.headers.location);
    https.get(res.headers.location, (res2) => downloadFile(res2));
    return;
  }
  downloadFile(res);
}).on('error', (e) => {
  console.error('Download error:', e.message);
  process.exit(1);
});

function downloadFile(res) {
  const total = parseInt(res.headers['content-length'] || '0');
  const file = fs.createWriteStream(destPath);
  let downloaded = 0;
  let lastLog = 0;

  res.on('data', (chunk) => {
    downloaded += chunk.length;
    const pct = total > 0 ? Math.round(downloaded / total * 100) : 0;
    if (pct - lastLog >= 10) {
      console.log(`${pct}% (${(downloaded/1024/1024).toFixed(1)} MB / ${(total/1024/1024).toFixed(1)} MB)`);
      lastLog = pct;
    }
  });

  res.pipe(file);

  file.on('finish', () => {
    file.close();
    console.log('Download complete! Size:', (downloaded/1024/1024).toFixed(1), 'MB');
    console.log('Saved to:', destPath);
  });

  file.on('error', (e) => {
    console.error('File error:', e.message);
    process.exit(1);
  });
}
