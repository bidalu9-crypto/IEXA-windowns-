#!/usr/bin/env node
/**
 * i18n apply: rewrite Chinese literals to IexaI18n.t() calls and append the
 * matching rows to the dictionary.
 *
 * Usage: node scripts/i18n-apply.cjs <batch.json>
 *
 *   { "files": ["services/ToolStreamView.js"],
 *     "rows": [{ "zh": "更新计划", "key": "tool.todo_write", "en": "…", "ja": "…" }] }
 *
 * Refuses to guess: a literal used for comparison, a property name or one that
 * carries escapes is reported and left alone, because replacing it would change
 * behaviour rather than only the text.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const DICT = path.join(RENDERER, 'services', 'I18nUi.js');
const CJK = /[\u4e00-\u9fa5]/;

const batchPath = process.argv[2];
if (!batchPath) {
  console.error('usage: node scripts/i18n-apply.cjs <batch.json>');
  process.exit(2);
}
const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
const byText = new Map();
for (const row of batch.rows) {
  if (byText.has(row.zh)) throw new Error('duplicate zh in batch: ' + row.zh);
  byText.set(row.zh, row);
}

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
const STRING_TESTS = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'match', 'test']);

function isGuarded(node, source) {
  let cur = node;
  while (cur.parent) {
    const parent = cur.parent;
    if (ts.isBinaryExpression(parent) && EQUALITY.has(parent.operatorToken.kind)) return 'equality';
    if (ts.isCaseClause(parent)) return 'switch-case';
    if (ts.isCallExpression(parent) && parent.expression && ts.isPropertyAccessExpression(parent.expression)
      && STRING_TESTS.has(parent.expression.name.text)) return 'string-test';
    if (ts.isPropertyAssignment(parent) && parent.name === cur) return 'property-name';
    if (ts.isNewExpression(parent) && parent.expression) break;
    cur = parent;
    if (ts.isStatement(parent) || ts.isFunctionLike(parent)) break;
  }
  return null;
}

let changedTotal = 0;
const skipped = [];
const missing = new Set();

for (const rel of batch.files) {
  const file = path.join(RENDERER, rel);
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];

  const consider = (node, textStart, textEnd, kind) => {
    const value = node.text;
    if (!CJK.test(value)) return;
    const row = byText.get(value);
    if (!row) { missing.add(`${rel}: ${value}`); return; }
    if (/[<>]/.test(value)) { skipped.push(`${rel}:${node.getStart(source)} markup ${JSON.stringify(value)}`); return; }
    const raw = text.slice(textStart, textEnd);
    if (raw !== value) { skipped.push(`${rel}:${node.getStart(source)} escape ${JSON.stringify(value)}`); return; }
    const guard = isGuarded(node, source);
    if (guard) { skipped.push(`${rel}:${node.getStart(source)} ${guard} ${JSON.stringify(value)}`); return; }
    const call = `IexaI18n.t('${row.key}')`;
    edits.push({ start: textStart, end: textEnd, replacement: kind === 'plain' ? call : '${' + call + '}' });
  };

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const start = node.getStart(source);
      consider(node, start, node.getEnd(), 'plain');
    } else if (ts.isTemplateExpression(node)) {
      consider(node.head, node.head.getStart(source) + 1, node.head.getEnd() - 2, 'part');
      for (const span of node.templateSpans) {
        consider(span.literal, span.literal.getStart(source) + 1, span.literal.getEnd() - 2, 'part');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  if (edits.length) fs.writeFileSync(file, out);
  changedTotal += edits.length;
  console.log(`${rel}: ${edits.length} replacement(s)`);
}

if (missing.size) {
  console.error('\nunmapped literals (add rows or drop them from files):');
  for (const item of missing) console.error('  ' + item);
  process.exit(1);
}

if (changedTotal || batch.rows.length) {
  let dict = fs.readFileSync(DICT, 'utf8');
  const anchor = '\n  };\n\n  const pick';
  if (!dict.includes(anchor)) throw new Error('dictionary anchor not found');
  const existing = new Set([...dict.matchAll(/^\s*'([^']+)': \{ zh:/gm)].map((m) => m[1]));
  const fresh = batch.rows.filter((row) => !existing.has(row.key));
  if (fresh.length) {
    const block = ['', `    /* ---- ${batch.name || path.basename(batchPath, '.json')} ---- */`,
      ...fresh.map((row) => `    '${row.key}': { zh: '${row.zh}', en: '${row.en}', ja: '${row.ja}' },`)].join('\n');
    dict = dict.replace(anchor, block + anchor);
    fs.writeFileSync(DICT, dict);
  }
  console.log(`dictionary: +${fresh.length} row(s)`);
}

if (skipped.length) {
  console.log(`\nleft for hand edits (${skipped.length}):`);
  for (const item of skipped) console.log('  ' + item);
}
