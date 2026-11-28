// Tee stdin to stdout and, when IEXA_LOG names a file, append it there too.
//
// Used by direct-http.bat and http-build-start.bat instead of
//   | powershell -NoProfile -Command "$input | Tee-Object -FilePath ..."
// because that costs a full PowerShell start plus a formatting pass per line,
// and Tee-Object writes UTF-16 on Windows PowerShell 5.1. This keeps the bytes
// exactly as node emitted them (UTF-8) and starts in tens of milliseconds.
//
// Appending on purpose: a crash loses the last buffered line otherwise, and the
// run that crashed is the one worth reading. Callers create the directory.
const fs = require('fs');

const target = process.env.IEXA_LOG || '';
let sink = null;
if (target) {
  try {
    sink = fs.createWriteStream(target, { flags: 'a' });
    sink.on('error', () => { sink = null; });
  } catch {
    sink = null;
  }
}

process.stdin.pipe(process.stdout, { end: false });
if (sink) process.stdin.pipe(sink, { end: false });
process.stdin.on('end', () => {
  if (sink) sink.end();
  // stdout may still be flushing; exit on its drain rather than immediately.
  process.stdout.write('', () => process.exit(0));
});
process.stdin.on('error', () => process.exit(0));
