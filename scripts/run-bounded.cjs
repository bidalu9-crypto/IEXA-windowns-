#!/usr/bin/env node
'use strict';

// Use for subsequent builds/checks after a system resource incident.
// node --max-old-space-size=128 scripts/run-bounded.cjs --output <evidence-dir> -- <script.js> [arguments]
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createSupervisor } = require('./helpers/acceptance-supervisor.cjs');
const root = path.resolve(__dirname, '..');

async function main(argv) {
  const separator = argv.indexOf('--'), options = argv.slice(0, separator);
  const outputIndex = options.indexOf('--output');
  if (separator < 0 || !argv[separator + 1] || outputIndex < 0 || !options[outputIndex + 1]) throw Error('Usage: run-bounded.cjs --output <evidence-dir> -- <script.js> [arguments]');
  const output = path.resolve(options[outputIndex + 1]), script = path.resolve(argv[separator + 1]);
  if (!fs.statSync(script).isFile()) throw Error('Workload entry is not a file');
  fs.mkdirSync(output, { recursive: true });
  const result = { startedAt: new Date().toISOString(), command: [process.execPath, '--max-old-space-size=512', script, ...argv.slice(separator + 2)], output, status: 'running' };
  const supervisor = createSupervisor({ output, maximumDurationMs: 300000 });
  let child;
  try {
    // Preflight finishes before any build/test subprocess is created.
    await supervisor.begin();
    const env = { ...process.env, NODE_OPTIONS: ((process.env.NODE_OPTIONS || '').replace(/--max[-_]old[-_]space[-_]size(?:=|\s+)\d+/g, '').trim() + ' --max-old-space-size=512').trim() };
    const fd = fs.openSync(path.join(output, 'workload.log'), 'w'), started = Date.now();
    try { child = spawn(process.execPath, result.command.slice(1), { cwd: root, env, windowsHide: true, stdio: ['ignore', fd, fd] }); }
    finally { fs.closeSync(fd); }
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    exited.catch(() => {});
    await supervisor.claimSpawn(child, script, started);
    result.exit = await Promise.race([exited, supervisor.failure]);
    if (result.exit.code !== 0 || result.exit.signal) throw Error('Workload failed: ' + JSON.stringify(result.exit));
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = error.stack; }
  finally {
    try { result.resources = await supervisor.finish(); }
    catch (error) { result.status = 'failed'; result.resourceError = error.message; }
    result.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({ status: result.status, error: result.error, resourceError: result.resourceError, report: path.join(output, 'result.json') }));
  return result.status === 'passed' ? 0 : 1;
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
