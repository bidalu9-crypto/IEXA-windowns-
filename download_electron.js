const https = require('https');
const fs = require('fs');
const path = require('path');

const version = '28.0.0';
const cacheDir = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache');
const zipName = `electron-v${version}-win32-x64.zip`;
const destPath = path.join(cacheDir, zipName);
const tempPath = `${destPath}.download`;
const url = new URL(`https://cdn.npmmirror.com/binaries/electron/${version}/${zipName}`);

// Ensure cache dir exists
fs.mkdirSync(cacheDir, { recursive: true });

console.log('Cache dir:', cacheDir);
console.log('Downloading:', zipName);
console.log('From:', url.href);

download(url, 0);

function download(currentUrl, redirectCount) {
  if (redirectCount > 5) return fail(new Error('Too many redirects'));
  const request = https.get(currentUrl, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      const nextUrl = new URL(res.headers.location, currentUrl);
      console.log('Following redirect to:', nextUrl.href);
      res.resume();
      download(nextUrl, redirectCount + 1);
      return;
    }
    if (res.statusCode !== 200) {
      res.resume();
      return fail(new Error(`HTTP ${res.statusCode || 'unknown'} while downloading Electron`));
    }
    downloadFile(res);
  });
  request.setTimeout(30_000, () => request.destroy(new Error('Download timed out')));
  request.on('error', fail);
}

function downloadFile(res) {
  const total = parseInt(res.headers['content-length'] || '0');
  const file = fs.createWriteStream(tempPath);
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
    file.close((error) => {
      if (error) return fail(error);
      if (total > 0 && downloaded !== total) {
        return fail(new Error(`Incomplete download: expected ${total} bytes, received ${downloaded}`));
      }
      if (downloaded < 10 * 1024 * 1024) {
        return fail(new Error(`Downloaded file is unexpectedly small: ${downloaded} bytes`));
      }
      try {
        fs.rmSync(destPath, { force: true });
        fs.renameSync(tempPath, destPath);
      } catch (renameError) {
        return fail(renameError);
      }
      console.log('Download complete! Size:', (downloaded/1024/1024).toFixed(1), 'MB');
      console.log('Saved to:', destPath);
    });
  });

  file.on('error', fail);
  res.on('error', fail);
}

function fail(error) {
  try { fs.rmSync(tempPath, { force: true }); } catch {}
  console.error('Electron setup error:', error.message);
  process.exit(1);
}
