'use strict';

// Reads only the explicitly selected package, build evidence, coverage plan,
// fixture sources and immediate *-packaged-* artifact directories. No browser,
// process control, provider request, session scan or product mutation occurs.
// Writes the two summaries and, only with --refresh-coverage, backed-up coverage.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const CONTROLLERS = ['DesktopAgent.js', 'desktop/DesktopControlSession.js', 'desktop/ChromiumCdpAdapter.js', 'desktop/CdpPageSnapshot.js'];
const GROUPS = ['navigation', 'pages', 'workbench', 'window', 'agent-features', 'bots', 'crud', 'overlays', 'media', 'desktop-live'];
const sha = data => createHash('sha256').update(data).digest('hex');
const slash = value => String(value).replace(/\\/g, '/');
const canonical = value => slash(path.resolve(value)).toLowerCase();
const samePath = (actual, expected) => typeof actual === 'string' && canonical(actual) === canonical(expected);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const relative = (root, filename) => slash(path.relative(root, filename));
const markdown = value => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
function writeJson(filename, value) {
  const temporary = filename + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, filename);
}
function optionalJson(filename) {
  try { return { data: readJson(filename) }; }
  catch (error) { return { error: error.message }; }
}

function optionsFrom(argv) {
  const root = path.resolve(__dirname, '../..');
  const artifacts = path.join(root, '.iexa-artifacts/desktop-components-20261109');
  const options = { root, artifacts, package: path.join(root, 'release/IEXA'), buildReport: path.join(artifacts, 'package-final-watch/result.json'), coverage: path.join(artifacts, 'component-coverage-plan.json'), distribution: path.join(artifacts, 'distribution-final.json'), testsLog: path.join(artifacts, 'desktop-tests.log'), requiredGroups: GROUPS, refreshCoverage: false, strict: false };
  const paths = { artifacts: 'artifacts', package: 'package', 'build-report': 'buildReport', coverage: 'coverage', distribution: 'distribution', 'tests-log': 'testsLog' };
  for (const arg of argv) {
    if (arg === '--refresh-coverage') options.refreshCoverage = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--help') options.help = true;
    else {
      const split = arg.indexOf('=');
      if (!arg.startsWith('--') || split < 3) throw Error('Expected --option=value: ' + arg);
      const key = arg.slice(2, split), value = arg.slice(split + 1);
      if (paths[key]) options[paths[key]] = path.resolve(value);
      else if (key === 'required-groups') options.requiredGroups = value.split(',').filter(Boolean);
      else throw Error('Unknown option: ' + key);
    }
  }
  return options;
}

function packageIdentity(options) {
  const manifestPath = path.join(options.package, 'build-manifest.json');
  const bytes = fs.readFileSync(manifestPath), manifest = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const build = readJson(options.buildReport), builtAt = timestamp(build.completedAt);
  if (build.status !== 'passed' || build.exit?.code !== 0 || build.exit?.signal || !Number.isFinite(builtAt)) throw Error('Build report must be completed, passed and exit 0: ' + options.buildReport);
  if (fs.statSync(manifestPath).mtimeMs > builtAt + 1000) throw Error('Current package manifest is newer than the selected completed build report');
  if (!Array.isArray(build.command) || !build.command.some(arg => slash(arg).endsWith('/build-dist.js') || arg === 'build-dist.js')) throw Error('Build report does not describe build-dist.js');
  const buildResources = build.resources;
  if (!buildResources || buildResources.stopReason || !(buildResources.peakRss > 0) || !(buildResources.sampleCount > 0) || ['survivorsBeforeCleanup', 'survivorsAfterCleanup', 'cleanupErrors'].some(key => !Array.isArray(buildResources[key]) || buildResources[key].length)) throw Error('Build resource/cleanup evidence is incomplete or failed');
  const appRoot = path.join(options.package, 'resources/app');
  const hashes = {}, verifiedFiles = [];
  // Verify the immutable executable, controller, native bridge and changed voice
  // source against the manifest. Runtime debug.log is intentionally not hashed.
  const names = ['IEXA.exe', ...CONTROLLERS.map(name => 'resources/app/dist/main/tools/' + name), 'resources/app/src/renderer/app.js', 'resources/app/desktop-agent/publish/Iexa.DesktopAgent.exe', 'resources/app/desktop-agent/publish/Iexa.DesktopAgent.dll'];
  for (const name of names) {
    const expected = manifest.files?.[name];
    if (!/^[a-fA-F0-9]{64}$/.test(expected || '')) throw Error('Manifest lacks required artifact: ' + name);
    const actual = sha(fs.readFileSync(path.join(options.package, name)));
    if (actual !== expected.toLowerCase()) throw Error('Current package file differs from build manifest: ' + name);
    verifiedFiles.push({ path: name, sha256: actual });
  }
  for (const name of CONTROLLERS) hashes[name] = manifest.files['resources/app/dist/main/tools/' + name].toLowerCase();
  const rendererManifestHashes = Object.fromEntries(Object.entries(manifest.files).filter(([name]) => name.startsWith('resources/app/src/renderer/') && !name.includes('/vendor/') && /\.(js|css|html)$/.test(name)));
  for (const [name, expected] of Object.entries(rendererManifestHashes)) if (sha(fs.readFileSync(path.join(options.package, name))) !== expected.toLowerCase()) throw Error('Current renderer file differs from build manifest: ' + name);
  return { manifestPath: relative(options.root, manifestPath), manifestSha256: sha(bytes), manifestListedFiles: Object.keys(manifest.files).length, electron: manifest.electron, productionPackages: manifest.packages, packageRoot: options.package, appRoot, exe: path.join(options.package, 'IEXA.exe'), buildReport: relative(options.root, options.buildReport), buildCompletedAt: build.completedAt, buildReportSha256: sha(fs.readFileSync(options.buildReport)), verifiedFiles, controllerSha256: hashes, rendererManifestHashes, integrityScope: 'Verified listed executable, four controllers, native bridge and every non-vendor renderer JS/CSS/HTML file against the current manifest; this is not a fresh full distribution audit. Renderer hashes are current-manifest evidence, not historical per-run snapshots.' };
}

function bindingReasons(report, identity) {
  const reasons = [], began = timestamp(report.startedAt), completed = timestamp(report.completedAt), created = timestamp(report.application?.created), cutoff = timestamp(identity.buildCompletedAt);
  if (!Number.isFinite(began) || !Number.isFinite(completed) || completed < began || Number.isFinite(created) && created > completed) reasons.push('Missing/invalid final run timestamps');
  if (typeof report.runId !== 'string' || !report.runId) reasons.push('Missing run ID');
  if (!['passed', 'failed'].includes(report.status)) reasons.push('Missing final run status');
  if (!Number.isFinite(began) || began < cutoff || !Number.isFinite(created) || created < cutoff) reasons.push('Run/application predates the completed current package build, or creation time is missing');
  if (!samePath(report.application?.exe, identity.exe)) reasons.push('Application executable is not the current packaged EXE');
  if (!samePath(report.application?.appRoot, identity.appRoot)) reasons.push('Application appRoot differs from current package');
  if (!samePath(report.controller?.appRoot, identity.appRoot)) reasons.push('Controller appRoot differs from current package');
  for (const name of CONTROLLERS) if (String(report.controller?.sha256?.[name] || '').toLowerCase() !== identity.controllerSha256[name]) reasons.push('Controller hash mismatch/missing: ' + name);
  const explicitHash = report.packageManifestSha256 || report.buildManifestSha256 || report.application?.packageManifestSha256 || report.packageManifest?.sha256;
  if (explicitHash && String(explicitHash).toLowerCase() !== identity.manifestSha256) reasons.push('Explicit package manifest SHA256 mismatch');
  if (!Array.isArray(report.checks) || !report.checks.length || report.checks.some(check => typeof check.name !== 'string' || !check.name || typeof check.passed !== 'boolean')) reasons.push('Malformed/empty checks array');
  return { reasons, method: explicitHash ? 'explicit_manifest_hash_plus_controller_paths_and_build_time' : 'legacy_controller_hashes_paths_and_post_build_time', fullManifestRecordedByRun: !!explicitHash };
}

function runHealth(report, directory) {
  const cleanupFile = path.join(directory, 'process-cleanup.json'), watchdogFile = path.join(directory, 'resource-watchdog.json');
  const cleanupRead = optionalJson(cleanupFile), watchdogRead = optionalJson(watchdogFile);
  const cleanup = cleanupRead.data, watchdog = watchdogRead.data, issues = [];
  if (report.applicationExitCode !== 0) issues.push('Application exit code is not 0: ' + report.applicationExitCode);
  for (const key of ['error', 'resourceStopReason', 'resourceError', 'exitError', 'nativeExitError']) if (report[key]) issues.push(key + ': ' + report[key]);
  if (!cleanup) issues.push('Missing/invalid independent cleanup JSON: ' + cleanupRead.error);
  if (!watchdog) issues.push('Missing/invalid resource watchdog JSON: ' + watchdogRead.error);
  for (const [label, resource] of [['report.resources', report.resources], ['process-cleanup.json', cleanup]]) {
    if (!resource) { issues.push(label + ' missing'); continue; }
    if (resource.stopReason) issues.push(label + ' resource stop: ' + resource.stopReason);
    if (!(resource.peakRss > 0) || !(resource.sampleCount > 0)) issues.push(label + ' lacks positive RSS/sample evidence');
    for (const key of ['survivorsBeforeCleanup', 'survivorsAfterCleanup', 'cleanupErrors']) if (!Array.isArray(resource[key]) || resource[key].length) issues.push(label + ' ' + key + ' is missing or non-empty');
  }
  if (watchdog?.stopReason) issues.push('Watchdog stop: ' + watchdog.stopReason);
  if (!Array.isArray(watchdog?.samples) || !watchdog.samples.length) issues.push('Watchdog samples missing');
  if (!(watchdog?.rssLimitBytes > 0)) issues.push('Watchdog RSS threshold missing');
  if (cleanup?.peakRss > watchdog?.rssLimitBytes) issues.push('Peak owned RSS exceeds watchdog threshold');
  if (report.resources && cleanup) {
    for (const key of ['stopReason', 'peakRss', 'sampleCount', 'survivorsBeforeCleanup', 'survivorsAfterCleanup', 'cleanupErrors']) if (JSON.stringify(report.resources[key]) !== JSON.stringify(cleanup[key])) issues.push('Inline/independent cleanup mismatch: ' + key);
  }
  const normalExitAndCleanupVerified = issues.length === 0;
  const runtimeErrors = Array.isArray(report.runtimeErrors) ? report.runtimeErrors : [];
  if (!Array.isArray(report.runtimeErrors)) issues.push('Runtime exception evidence array missing');
  if (runtimeErrors.length) issues.push(runtimeErrors.length + ' renderer runtime exception(s), retained independently of check outcomes');
  const knownToolIssues = Array.isArray(report.knownToolIssues) ? report.knownToolIssues : [];
  if (knownToolIssues.length) issues.push(knownToolIssues.length + ' known desktop tool issue(s) require separate audit; independent business evidence does not remove the tool result');
  const failedActions = (report.actions || []).flatMap((action, index) => action.success === false ? [{ index, action: action.action, channel: action.channel || 'cdp', target: action.target || null, output: action.output, desktop: action.desktop || null }] : []);
  return { normalExitAndCleanupVerified, verified: issues.length === 0, issues, applicationExitCode: report.applicationExitCode ?? null, peakRssBytes: cleanup?.peakRss ?? report.resources?.peakRss ?? null, rssLimitBytes: watchdog?.rssLimitBytes ?? null, stopReason: report.resourceStopReason || cleanup?.stopReason || watchdog?.stopReason || '', survivorsBeforeCleanup: cleanup?.survivorsBeforeCleanup ?? null, survivorsAfterCleanup: cleanup?.survivorsAfterCleanup ?? null, cleanupErrors: cleanup?.cleanupErrors ?? null, runtimeErrors, knownToolIssues, failedActionCount: failedActions.length, failedActions };
}

function expectedChecks(options, coverage) {
  const expected = new Map((coverage?.checkInventory || []).map(item => [item.name, { name: item.name, group: item.group, source: item.source, line: item.line, id: item.id }]));
  // Window checks were added after the static plan. Read their real literal
  // declarations plus the explicit two-edge loop; never use observed results as
  // the completeness oracle and never execute the fixture to discover checks.
  const source = 'scripts/fixtures/iexa-component-window.cjs', filename = path.join(options.root, source);
  if (fs.existsSync(filename)) {
    const text = fs.readFileSync(filename, 'utf8'); let index = 0;
    for (const match of text.matchAll(/await h\.check\('([^']+)',\s*async/g)) {
      const id = 'WIN' + String(++index).padStart(2, '0');
      if (!expected.has(match[1])) expected.set(match[1], { name: match[1], group: 'window', source, line: text.slice(0, match.index).split('\n').length, id });
    }
    const loop = "for (const edge of ['e', 's']) await h.check('Window / actual native ' + edge + ' edge drag changes OS size and returns to original geometry'";
    if (text.includes(loop)) for (const edge of ['e', 's']) {
      const name = 'Window / actual native ' + edge + ' edge drag changes OS size and returns to original geometry';
      const id = 'WIN' + String(++index).padStart(2, '0');
      if (!expected.has(name)) expected.set(name, { name, group: 'window', source, line: text.slice(0, text.indexOf(loop)).split('\n').length, id });
    }
  }
  if (!expected.size) throw Error('No expected check inventory; supply the actual coverage plan');
  return expected;
}

function supplementary(filename, root, log = false) {
  if (!fs.existsSync(filename)) return { path: relative(root, filename), exists: false };
  const bytes = fs.readFileSync(filename), result = { path: relative(root, filename), exists: true, bytes: bytes.length, sha256: sha(bytes) };
  if (log) {
    const text = bytes.toString('utf8'), totals = {};
    for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) { const matches = [...text.matchAll(new RegExp('^# ' + key + '\\s+(\\d+)\\s*$', 'gm'))]; if (matches.length) totals[key] = Number(matches.at(-1)[1]); }
    result.tap = totals;
    result.completePassingTap = totals.tests > 0 && totals.pass > 0 && totals.fail === 0 && (totals.cancelled || 0) === 0;
    result.scope = 'Referenced independent Node test log; counts are not added to GUI unique checks and are not proof of online model behavior.';
  } else {
    const parsed = optionalJson(filename);
    result.validation = parsed.data || { parseError: parsed.error };
    result.scope = 'Referenced distribution audit; interpret its actual schema separately from GUI checks.';
  }
  return result;
}

function refreshCoverage(options, result, coverage, expected) {
  const backupDir = path.join(options.artifacts, 'summary-backups'); fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'), backup = path.join(backupDir, 'component-coverage-plan-' + stamp + '.json');
  fs.copyFileSync(options.coverage, backup, fs.constants.COPYFILE_EXCL);
  writeJson(backup + '.manifest.json', { source: options.coverage, backup, sha256: sha(fs.readFileSync(backup)), reason: 'Preserve historical coverage before appending current packaged run snapshots' });
  coverage.recordedRuns ||= [];
  const existing = new Set(coverage.recordedRuns.map(run => slash(run.report)));
  for (const run of result.runs) if (!existing.has(run.report)) {
    coverage.recordedRuns.push({ report: run.report, runId: run.runId, status: run.reportStatus, startedAt: run.startedAt, completedAt: run.completedAt, recordedCheckCount: run.checkCount, passed: run.passed, failed: run.failed, sourceHashBinding: run.binding, packageManifestSha256AtSummary: result.package.manifestSha256, packageBindingLimit: 'Legacy reports did not snapshot a full package manifest; controller hashes, exact package paths and post-build timestamps establish this scope.', normalExitAndCleanupVerified: run.health.normalExitAndCleanupVerified, runtimeErrorCount: run.health.runtimeErrors.length, checks: result.checks.flatMap(check => check.attempts.filter(attempt => attempt.report === run.report).map(attempt => ({ name: check.name, passed: attempt.passed, error: attempt.error, superseded: attempt.superseded }))) });
    existing.add(run.report);
  }
  coverage.checkInventory ||= [];
  const inventory = new Map(coverage.checkInventory.map(check => [check.name, check]));
  for (const item of expected.values()) if (!inventory.has(item.name)) { const entry = { ...item, coverage: 'implemented' }; coverage.checkInventory.push(entry); inventory.set(item.name, entry); }
  for (const [name, entry] of inventory) {
    const actual = result.checks.find(check => check.name === name);
    entry.currentRevisionExecution = actual ? (actual.latest.passed ? 'current_packaged_latest_passed' : 'current_packaged_latest_failed') : 'current_packaged_not_observed';
    entry.currentPackageEvidence = actual ? { report: actual.latest.report, runId: actual.latest.runId, attemptId: actual.latest.attemptId, packageManifestSha256AtSummary: result.package.manifestSha256, bindingMethod: actual.latest.bindingMethod } : null;
  }
  if (!coverage.fixtureGroups.some(group => group.group === 'window')) coverage.fixtureGroups.push({ group: 'window', file: 'scripts/fixtures/iexa-component-window.cjs', implementedChecks: [...expected.values()].filter(check => check.group === 'window').length, integratedInEntrypoint: true, execution: 'see final-component-acceptance.json; historical failures retained' });
  const paths = [...new Set([...(coverage.sourceInventory || []).map(item => item.path), 'scripts/fixtures/iexa-component-window.cjs', relative(options.root, __filename)])];
  coverage.sourceInventory = paths.filter(name => fs.existsSync(path.join(options.root, name))).map(name => { const file = path.join(options.root, name), stat = fs.statSync(file); return { path: name, bytes: stat.size, lastWriteTime: stat.mtime.toISOString(), sha256: sha(fs.readFileSync(file)).toUpperCase() }; });
  coverage.generatedAt = result.generatedAt;
  Object.assign(coverage.summary, { fixtureGroupCount: coverage.fixtureGroups.length, fixtureCheckCount: coverage.fixtureGroups.reduce((sum, group) => sum + group.implementedChecks, 0), checkInventoryCount: coverage.checkInventory.length, recordedRunsRefresh: 'Current packaged run snapshots appended; older snapshots preserved', finalAcceptance: { report: relative(options.root, path.join(options.artifacts, 'final-component-acceptance.json')), status: result.status, uniqueChecks: result.summary.uniqueCheckCount, passed: result.summary.latestPassed, failed: result.summary.latestFailed, missingExpected: result.summary.missingExpectedCount, manifestSha256: result.package.manifestSha256 } });
  writeJson(options.coverage, coverage);
  return { updated: true, backup: relative(options.root, backup), recordedRuns: coverage.recordedRuns.length };
}

function summarize(options) {
  const identity = packageIdentity(options), coverage = readJson(options.coverage), expected = expectedChecks(options, coverage);
  const runs = [], excludedRuns = [], attempts = new Map();
  const directories = fs.readdirSync(options.artifacts, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^.+-packaged-.+$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  for (const directory of directories) {
    const dirname = path.join(options.artifacts, directory.name), filename = path.join(dirname, 'report.json'), reportPath = relative(options.root, filename);
    const parsed = optionalJson(filename);
    if (!parsed.data) { excludedRuns.push({ report: reportPath, category: 'pending_or_invalid_json', reasons: [parsed.error] }); continue; }
    const report = parsed.data, binding = bindingReasons(report, identity);
    if (binding.reasons.length) {
      const currentIdentity = timestamp(report.startedAt) >= timestamp(identity.buildCompletedAt) && samePath(report.application?.exe, identity.exe) && CONTROLLERS.every(name => String(report.controller?.sha256?.[name] || '').toLowerCase() === identity.controllerSha256[name]);
      excludedRuns.push({ report: reportPath, reportSha256: sha(fs.readFileSync(filename)), runId: report.runId || null, startedAt: report.startedAt || null, completedAt: report.completedAt || null, reportStatus: report.status || null, category: (!report.completedAt || !report.status) && currentIdentity ? 'pending' : 'out_of_scope', reasons: binding.reasons, resourceStopReason: report.resourceStopReason || report.resources?.stopReason || '', checkCount: Array.isArray(report.checks) ? report.checks.length : null, failedChecks: (Array.isArray(report.checks) ? report.checks : []).filter(check => check.passed === false).map(check => ({ name: check.name, error: check.error || null })), runtimeErrors: report.runtimeErrors || [], knownToolIssues: report.knownToolIssues || [] }); continue;
    }
    const health = runHealth(report, dirname), group = directory.name.split('-packaged-')[0];
    const run = { report: reportPath, reportSha256: sha(fs.readFileSync(filename)), group, runId: report.runId, startedAt: report.startedAt, completedAt: report.completedAt, reportStatus: report.status, checkCount: report.checks.length, passed: report.checks.filter(check => check.passed).length, failed: report.checks.filter(check => !check.passed).length, binding, health };
    runs.push(run);
    report.checks.forEach((check, index) => {
      const attempt = { attemptId: report.runId + ':' + index, report: reportPath, runId: report.runId, group, checkIndex: index, startedAt: report.startedAt, completedAt: report.completedAt, passed: check.passed, durationMs: check.durationMs ?? null, error: check.error || null, evidence: check.evidence ?? null, bindingMethod: binding.method, runHealthVerified: health.verified, superseded: false };
      if (!attempts.has(check.name)) attempts.set(check.name, []);
      attempts.get(check.name).push(attempt);
    });
  }
  const compare = (a, b) => timestamp(a.startedAt) - timestamp(b.startedAt) || timestamp(a.completedAt) - timestamp(b.completedAt) || a.report.localeCompare(b.report) || (a.checkIndex || 0) - (b.checkIndex || 0);
  runs.sort(compare);
  const checks = [...attempts].map(([name, history]) => {
    history.sort(compare); const latest = history.at(-1);
    for (const attempt of history.slice(0, -1)) { attempt.superseded = true; attempt.supersededBy = latest.attemptId; }
    return { name, inventoryId: expected.get(name)?.id || null, group: expected.get(name)?.group || latest.group, latest, attempts: history, failureAttempts: history.filter(attempt => !attempt.passed), recovered: latest.passed && history.some(attempt => !attempt.passed) };
  }).sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  const missingExpected = [...expected.values()].filter(item => !attempts.has(item.name));
  const missingGroups = options.requiredGroups.filter(group => !runs.some(run => run.group === group));
  const latestFailed = checks.filter(check => !check.latest.passed).length;
  const unhealthyRuns = runs.filter(run => !run.health.verified);
  const pending = excludedRuns.filter(run => run.category.startsWith('pending'));
  const status = latestFailed ? 'failed' : missingExpected.length || missingGroups.length || pending.length ? 'incomplete' : unhealthyRuns.length ? 'review_required' : 'passed';
  const result = { schemaVersion: 1, generatedAt: new Date().toISOString(), status, workspace: options.root, package: identity, selection: { directories: '*-packaged-* immediate children only', requiredGroups: options.requiredGroups, newestCheckRule: 'Exact check.name; later startedAt, then completedAt, then stable report path/index wins; no preference for passing attempts', legacyBindingLimit: 'Existing runs did not record a whole-package manifest hash. Current scope uses exact package EXE/appRoot/controllerRoot paths, four matching controller hashes, and run/application start after the successful build completedAt.' }, summary: { completedInScopeRuns: runs.length, excludedOrPendingRuns: excludedRuns.length, totalCheckOccurrences: checks.reduce((sum, check) => sum + check.attempts.length, 0), uniqueCheckCount: checks.length, latestPassed: checks.length - latestFailed, latestFailed, expectedCheckCount: expected.size, missingExpectedCount: missingExpected.length, unexpectedObservedCount: checks.filter(check => !expected.has(check.name)).length, supersededAttempts: checks.reduce((sum, check) => sum + check.attempts.length - 1, 0), historicalFailedAttempts: checks.reduce((sum, check) => sum + check.failureAttempts.length, 0), recoveredCheckCount: checks.filter(check => check.recovered).length, normalExitAndCleanupRuns: runs.filter(run => run.health.normalExitAndCleanupVerified).length, unhealthyRunCount: unhealthyRuns.length, rendererRuntimeExceptions: runs.reduce((sum, run) => sum + run.health.runtimeErrors.length, 0), resourceStopRuns: runs.filter(run => run.health.stopReason).length, peakOwnedRssBytes: runs.length ? Math.max(...runs.map(run => run.health.peakRssBytes || 0)) : null, pendingRunCount: pending.length }, missingExpected, missingGroups, runs, checks, excludedRuns, recoveredChecks: checks.filter(check => check.recovered).map(check => ({ name: check.name, latestAttempt: check.latest.attemptId, failedAttempts: check.failureAttempts.map(attempt => attempt.attemptId) })), runIssues: unhealthyRuns.map(run => ({ report: run.report, runId: run.runId, issues: run.health.issues })), historicalResourceIncidents: coverage.resourceIncidents || [], uncovered: { requirements: (coverage.priorityGaps || []).filter(gap => gap.implementationStatus !== 'implemented').map(gap => ({ id: gap.id, priority: gap.priority, feature: gap.feature, implementationStatus: gap.implementationStatus || 'uncovered', remainingAcceptance: gap.remainingAcceptance || gap.acceptance })), pageDetails: coverage.pages.map(page => ({ id: page.id, uncovered: page.uncovered || [], limits: page.limits || [] })).filter(page => page.uncovered.length || page.limits.length), dynamicDetails: coverage.dynamicComponents.map(item => ({ id: item.id, uncovered: item.uncovered || [], limits: item.limits || [] })).filter(item => item.uncovered.length || item.limits.length) }, boundaries: ['这些是实际打包 EXE 的控件、运行时、磁盘和持久记录验收；模型使用隔离的确定性本地 provider，不证明在线模型自主操作质量。', '生产 DesktopAgent 是控制器；CDP read 仅作 DOM/GET 结果 oracle；原生输入场景另有实际窗口与进程证据。', '同名检查仅计算最新结果一次；失败尝试和后续恢复均保留，不把各次重跑检查数相加当覆盖总数。', '检查最新结果通过不代表每次运行无异常；退出、清理、资源上限和 renderer runtime errors 单列。', '真实麦克风权限拒绝与 DOM/vm 语音回归不证明录音、设备输入或成功转写；截图附件没有发送模型。', 'Bot 团队是按规划串行运行的独立 Bot 会话；spawn_agent 子代理能力由 agent-features 组独立核验。', '既有源代码阶段曾触发 1.2 GiB 所属 RSS 上限；历史事件及清理结果保留，不能描述为全程未触发上限。'], supplementaryEvidence: { distribution: supplementary(options.distribution, options.root), tests: supplementary(options.testsLog, options.root, true) } };
  result.groups = [...new Set([...options.requiredGroups, 'entrypoint', ...checks.map(check => check.group)])].map(group => { const items = checks.filter(check => check.group === group); return { group, completedRuns: runs.filter(run => run.group === group).length, uniqueChecks: items.length, passed: items.filter(check => check.latest.passed).length, failed: items.filter(check => !check.latest.passed).length, missingExpected: missingExpected.filter(check => check.group === group).map(check => check.name) }; });
  result.toolAudit = { knownIssueCount: runs.reduce((sum, run) => sum + run.health.knownToolIssues.length, 0), failedActionCount: runs.reduce((sum, run) => sum + run.health.failedActionCount, 0), interpretation: 'Known tool issues stay visible even when independent business assertions pass. Raw failed actions are preserved for contextual review and are not automatically rewritten as successful actions.', reports: runs.filter(run => run.health.knownToolIssues.length || run.health.failedActionCount).map(run => ({ report: run.report, runId: run.runId, knownToolIssues: run.health.knownToolIssues, failedActions: run.health.failedActions })) };
  const failedInputs = runs.flatMap(run => run.health.failedActions);
  result.toolAudit.staleTargetRejectionsBeforeInput = failedInputs.filter(action => action.channel === 'cdp' && action.desktop?.acknowledgedActions === 0 && /^Error: Input target is stale:/.test(action.output)).length;
  result.toolAudit.otherFailedActions = failedInputs.length - result.toolAudit.staleTargetRejectionsBeforeInput;
  result.toolAudit.staleInterpretation = 'Production requireNode rejects changed target identity/value/geometry before apply/prepare input. Harness takes a fresh observation with at most three attempts; acknowledged input is never replayed. The original rejected attempts remain failures in this audit.';
  result.summary.failedAttemptCount = checks.reduce((sum, check) => sum + check.failureAttempts.length, 0);
  result.summary.historicalFailedAttempts = checks.reduce((sum, check) => sum + check.failureAttempts.filter(attempt => attempt.superseded).length, 0);
  result.summary.knownToolIssueCount = result.toolAudit.knownIssueCount;
  result.summary.failedActionCount = result.toolAudit.failedActionCount;
  if (options.refreshCoverage) result.coverageRefresh = refreshCoverage(options, result, coverage, expected);
  fs.mkdirSync(options.artifacts, { recursive: true });
  const previous = ['final-component-acceptance.json', 'final-component-acceptance.md'].filter(name => fs.existsSync(path.join(options.artifacts, name)));
  if (previous.length) {
    const archive = path.join(options.artifacts, 'summary-backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
    fs.mkdirSync(archive, { recursive: true });
    const files = previous.map(name => { const source = path.join(options.artifacts, name), backup = path.join(archive, name); fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL); return { source: relative(options.root, source), backup: relative(options.root, backup), sha256: sha(fs.readFileSync(backup)) }; });
    writeJson(path.join(archive, 'manifest.json'), { reason: 'Preserve prior package acceptance snapshot before rerunning summary', files });
    result.previousSummaryArchive = relative(options.root, archive);
  }
  writeJson(path.join(options.artifacts, 'final-component-acceptance.json'), result);
  fs.writeFileSync(path.join(options.artifacts, 'final-component-acceptance.md'), renderMarkdown(result), 'utf8');
  return result;
}

function renderMarkdown(result) {
  const s = result.summary;
  const groupTable = ['| 检查分类 | 唯一检查 | 最新通过 | 最新失败 | 尚缺预期 |', '|---|---:|---:|---:|---:|', ...result.groups.map(group => `| ${markdown(group.group)} | ${group.uniqueChecks} | ${group.passed} | ${group.failed} | ${group.missingExpected.length} |`)].join('\n');
  const lines = [
    `当前打包版汇总状态：**${result.status}**。按检查名称去重后，最新结果为 **${s.latestPassed}/${s.uniqueCheckCount} 通过、${s.latestFailed} 失败**；静态预期 ${s.expectedCheckCount} 项，尚缺 ${s.missingExpectedCount} 项。`,
    `生成时间：${result.generatedAt}。纳入 ${s.completedInScopeRuns} 份完成报告，共 ${s.totalCheckOccurrences} 次检查记录；${s.supersededAttempts} 次被后续同名结果替代，历史失败 ${s.historicalFailedAttempts} 次、已恢复检查 ${s.recoveredCheckCount} 项。`,
    `当前包：${result.package.packageRoot}；Electron ${result.package.electron}。build-manifest SHA256：\`${result.package.manifestSha256}\`。构建完成于 ${result.package.buildCompletedAt}，证据为 \`${result.package.buildReport}\`。`,
    `当前纳入的 ${result.runs.filter(run => run.binding.fullManifestRecordedByRun).length}/${result.runs.length} 份报告在启动时记录了整包 manifest 哈希，同时核对精确 EXE/appRoot/controllerRoot 路径、构建后启动时间及四个控制器哈希。旧报告使用的较弱绑定在 JSON 中分别保留。`,
    groupTable,
    `退出与清理核验通过 ${s.normalExitAndCleanupRuns}/${s.completedInScopeRuns} 份；有待审阅的运行 ${s.unhealthyRunCount} 份，renderer runtime exception 共 ${s.rendererRuntimeExceptions} 条。当前范围资源停止 ${s.resourceStopRuns} 次，所属进程峰值 RSS ${s.peakOwnedRssBytes ?? '无记录'} bytes。`,
  ];
  for (const issue of result.runIssues) lines.push(`运行问题：\`${issue.report}\`：${issue.issues.map(markdown).join('；')}`);
  lines.push(`桌面工具独立审计：knownToolIssues ${result.toolAudit.knownIssueCount} 条，原始失败动作 ${result.toolAudit.failedActionCount} 次。独立业务断言通过不会把工具回执改写成成功，JSON 保留每个失败动作的序号、输出及桌面元数据。`);
  lines.push(`其中 ${result.toolAudit.staleTargetRejectionsBeforeInput} 次是生产 requireNode 在执行输入前发现目标状态或几何变化而拒绝；acknowledgedActions 均为 0。验收器重新观察后继续，每个动作最多三次尝试，已确认执行的输入不重放。其它原始失败 ${result.toolAudit.otherFailedActions} 次。`);
  for (const audit of result.toolAudit.reports) for (const issue of audit.knownToolIssues) lines.push(`工具问题：\`${audit.report}\`；动作 ${issue.action || '未标注'}；${issue.issue || JSON.stringify(issue)}；独立业务证据：${issue.independentlyVerified || '无'}。`);
  for (const check of result.recoveredChecks) lines.push(`已恢复：${check.name}；保留失败尝试 ${check.failedAttempts.join(', ')}；最新 ${check.latestAttempt}。`);
  for (const check of result.checks.filter(check => !check.latest.passed)) lines.push(`最新失败：${check.name}；\`${check.latest.report}\`；${check.latest.error}`);
  if (result.missingGroups.length) lines.push('尚无当前完成报告的组：' + result.missingGroups.join('、') + '。');
  if (result.missingExpected.length) lines.push('尚未观察到的预期检查：\n\n' + result.missingExpected.map(item => '- ' + item.name).join('\n'));
  if (result.excludedRuns.length) lines.push('排除或仍在运行的报告：\n\n' + result.excludedRuns.map(run => '- `' + run.report + '` [' + run.category + ']：' + run.reasons.join('；')).join('\n'));
  lines.push('每份纳入报告的退出与资源记录：\n\n| 报告 | 原报告状态 | 检查通过/总数 | 退出码 | 峰值 RSS bytes | 清理后残留 | runtime errors |\n|---|---|---:|---:|---:|---:|---:|\n' + result.runs.map(run => `| ${markdown(run.report)} | ${run.reportStatus} | ${run.passed}/${run.checkCount} | ${run.health.applicationExitCode} | ${run.health.peakRssBytes} | ${run.health.survivorsAfterCleanup?.length ?? '缺证据'} | ${run.health.runtimeErrors.length} |`).join('\n'));
  for (const incident of result.historicalResourceIncidents) lines.push(`历史资源事件：\`${incident.report}\`，${incident.resourceStopReason}；峰值 ${incident.peakRssBytes} bytes，阈值 ${incident.rssLimitBytes} bytes，清理后残留 ${incident.survivorsAfterCleanup}。${incident.interpretation || ''} ${incident.repair || ''}`);
  lines.push('控制器和模型夹具边界：\n\n' + result.boundaries.map(item => '- ' + item).join('\n'));
  lines.push('仍有实现缺口或仅部分覆盖的需求：\n\n' + result.uncovered.requirements.map(item => `- ${item.id} ${item.feature}：${(item.remainingAcceptance || []).join('；')}`).join('\n'));
  lines.push('页面和动态组件的详细限制、全部最新检查、原始证据及 superseded 尝试保存在同目录 `final-component-acceptance.json`。');
  for (const [label, evidence] of Object.entries(result.supplementaryEvidence)) lines.push(`补充证据 ${label}：\`${evidence.path}\`，${evidence.exists ? 'SHA256 ' + evidence.sha256 : '文件尚未生成'}${evidence.tap ? '；TAP ' + JSON.stringify(evidence.tap) : ''}。`);
  return lines.join('\n\n') + '\n';
}

if (require.main === module) {
  try {
    const options = optionsFrom(process.argv.slice(2));
    if (options.help) console.log('node scripts/helpers/summarize-iexa-components.cjs [--build-report=PATH] [--distribution=PATH] [--tests-log=PATH] [--refresh-coverage] [--strict]\nOther path options: --artifacts=PATH --package=PATH --coverage=PATH. --required-groups=comma,separated overrides required report groups.');
    else { const result = summarize(options); console.log(JSON.stringify({ status: result.status, ...result.summary, output: options.artifacts })); if (options.strict && result.status !== 'passed') process.exitCode = 1; }
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { optionsFrom, packageIdentity, bindingReasons, runHealth, expectedChecks, summarize, renderMarkdown };
