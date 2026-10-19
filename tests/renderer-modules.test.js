// Guard rails for the classic-script renderer.
//
// app.js used to be one 10k-line file. It is now a shell plus feature services
// that share a single global scope, which buys readability but introduces two
// failure modes that only show up in a real browser: a script tag missing from
// index.html, and a name declared twice at top level (a SyntaxError that blanks
// the whole app). Both are cheap to check here and expensive to debug at runtime.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'src/renderer');
const bundle = require('./helpers/renderer-bundle');

const APP_LINES = 4600;
const MODULE_LINES = 1200;

function countLines(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n').length;
}

// Only the scripts index.html is responsible for. auth-login.js and
// desktop-live.js belong to their own pages, and PluginSDK.js is served to
// plugin iframes by the API rather than loaded into the app shell.
const NOT_LOADED_BY_INDEX = new Set(['services/PluginSDK.js']);

function rendererScripts() {
  const out = ['app.js'];
  for (const dir of ['services', 'components']) {
    for (const name of fs.readdirSync(path.join(RENDERER, dir))) {
      if (!name.endsWith('.js')) continue;
      const src = `${dir}/${name}`;
      if (NOT_LOADED_BY_INDEX.has(src)) continue;
      out.push(src);
    }
  }
  return out;
}

function unwrapParens(node) {
  let n = node;
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
}

// Both spellings occur in this codebase: (function () { ... })() and
// (function () { ... }()).
function isIife(expr) {
  const call = unwrapParens(expr);
  if (!ts.isCallExpression(call)) return false;
  const callee = unwrapParens(call.expression);
  return ts.isFunctionExpression(callee) || ts.isArrowFunction(callee);
}

test('every renderer script is loaded exactly once and in a workable order', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const listed = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);

  const duplicates = listed.filter((src, i) => listed.indexOf(src) !== i);
  assert.deepEqual(duplicates, [], 'scripts loaded twice: ' + duplicates.join(', '));

  // A file that exists but is never loaded is dead weight; a script that is
  // loaded but missing breaks the app at startup.
  for (const src of rendererScripts()) {
    assert.ok(listed.includes(src), `renderer script is not loaded by index.html: ${src}`);
  }
  for (const src of listed) {
    if (src.startsWith('vendor/')) continue;
    assert.ok(fs.existsSync(path.join(RENDERER, src)), `index.html loads a missing script: ${src}`);
  }

  const appIndex = listed.indexOf('app.js');
  assert.ok(appIndex > 0, 'app.js must be listed');
  const trailing = new Set(['services/WorkbenchShell.js', 'services/WindowChrome.js']);
  for (const src of listed) {
    if (src === 'app.js' || trailing.has(src)) continue;
    assert.ok(listed.indexOf(src) < appIndex, `script must load before app.js: ${src}`);
  }
});

test('no top-level declaration is duplicated across renderer scripts', () => {
  // Concatenated, the renderer is one script scope. A repeat here is a real
  // SyntaxError in the browser ("Identifier has already been declared").
  const combined = ts.createSourceFile('renderer.js', bundle.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const seen = new Map();
  for (const node of combined.statements) {
    if (!(ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableStatement(node))) continue;
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.name?.text) seen.set(decl.name.text, (seen.get(decl.name.text) || 0) + 1);
      }
      continue;
    }
    if (node.name?.text) seen.set(node.name.text, (seen.get(node.name.text) || 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
  assert.deepEqual(duplicates, [], 'duplicate top-level declarations: ' + JSON.stringify(duplicates));
});

test('app.js stays a shell and every feature module stays reviewable', () => {
  const app = path.join(RENDERER, 'app.js');
  assert.ok(countLines(app) <= APP_LINES,
    `app.js has grown past ${APP_LINES} lines (${countLines(app)}); move a feature into services/`);

  for (const src of rendererScripts()) {
    if (src === 'app.js') continue;
    const lines = countLines(path.join(RENDERER, src));
    assert.ok(lines <= MODULE_LINES, `${src} is ${lines} lines (limit ${MODULE_LINES}); split it by feature`);
  }
});

test('modules declare themselves and do their wiring from init', () => {
  // A module may only contain declarations and IIFE wrappers at top level.
  // Anything else runs while index.html is still loading this script, which is
  // before app.js has initialised the state the module may depend on.
  for (const src of rendererScripts()) {
    if (src === 'app.js') continue;
    const text = fs.readFileSync(path.join(RENDERER, src), 'utf8');
    const first = text.split('\n').find((line) => line.trim() !== '') || '';
    assert.match(first, /^(\/\/|\/\*|'use strict'|"use strict"|\(function|\(\(\)|const |let |var |class )/,
      `${src} must start with a comment or a declaration`);

    const sf = ts.createSourceFile(src, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const offenders = [];
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isVariableStatement(stmt)) continue;
      if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) continue;
      if (ts.isExpressionStatement(stmt) && isIife(stmt.expression)) continue;
      offenders.push(stmt.getText(sf).split('\n')[0].slice(0, 100));
    }
    assert.deepEqual(offenders, [], `${src} runs code at load time: ${offenders.join(' | ')}`);
  }
});
