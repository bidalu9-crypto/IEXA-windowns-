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
 * Two shapes are handled:
 *   - the literal is exactly the Chinese text  -> IexaI18n.t('key')
 *   - the text sits inside a markup string     -> '…' + IexaI18n.t('key') + '…'
 *     (a template literal gets ${…} instead, so attribute values stay intact)
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
const DICT = path.join(RENDERER, 'services', 'I18nUiPanels.js');
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
  // The dictionary is a single-quoted JS table: an apostrophe in any locale would
  // close the string and break every translation at load time.
  for (const field of ['zh', 'en', 'ja']) {
    if (typeof row[field] !== 'string') throw new Error(`row ${row.key} is missing ${field}`);
    if (row[field].includes("'")) throw new Error(`row ${row.key} ${field} contains an apostrophe: ${row[field]}`);
  }
  byText.set(row.zh, row);
}
// Longest first, so "刷新中…" wins over "刷新".
const orderedRows = [...batch.rows].sort((a, b) => b.zh.length - a.zh.length);

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
const STRING_TESTS = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'match', 'test']);

function isGuarded(node) {
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
  const lines = text.split('\n');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];

  /** Where the literal's text starts, how wide the quote is, and what syntax a split needs. */
  const body = (node) => {
    const start = node.getStart(source);
    if (ts.isStringLiteral(node)) {
      const quote = text[start];
      return { start: start + 1, end: node.getEnd() - 1, quote, template: false, node };
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      return { start: start + 1, end: node.getEnd() - 1, quote: '`', template: true, node };
    }
    return { start: start + 1, end: node.getEnd() - 2, quote: '`', template: true, node };
  };

  const consider = (node) => {
    const value = node.text;
    if (!CJK.test(value)) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    if (/i18n-exempt/.test(lines[line] || '')) return;

    const { start, end, quote, template } = body(node);
    const raw = text.slice(start, end);
    if (raw !== value) {
      skipped.push(`${rel}:${node.getStart(source)} escape ${JSON.stringify(value)}`);
      return;
    }

    const split = template ? (key) => '${IexaI18n.t(\'' + key + '\')}' : (key) => quote + ' + IexaI18n.t(\'' + key + '\') + ' + quote;
    const whole = template ? (key) => '${IexaI18n.t(\'' + key + '\')}' : (key) => 'IexaI18n.t(\'' + key + '\')';

    const exact = byText.get(value);
    if (exact) {
      const guard = isGuarded(node);
      if (guard) {
        skipped.push(`${rel}:${node.getStart(source)} ${guard} ${JSON.stringify(value)}`);
        return;
      }
      if (template) {
        // Inside a template literal the call has to stay inside the text, so the
        // chunk keeps its delimiters and gains an interpolation.
        edits.push({ start, end, replacement: whole(exact.key) });
      } else {
        // A quoted literal is replaced whole (quotes included), otherwise the
        // call would end up wrapped in the old quotes.
        edits.push({ start: node.getStart(source), end: node.getEnd(), replacement: whole(exact.key) });
      }
      return;
    }

    // A fragment of a bigger string: only inside markup, and never on a value
    // that is compared rather than rendered.
    let out = value;
    const used = [];
    for (const row of orderedRows) {
      if (!out.includes(row.zh)) continue;
      out = out.split(row.zh).join(split(row.key));
      used.push(row.key);
    }
    if (!used.length) {
      if (/[<>]/.test(value)) return; // markup with nothing mapped: leave alone
      missing.add(`${rel}: ${value}`);
      return;
    }
    const guard = isGuarded(node);
    if (guard) {
      skipped.push(`${rel}:${node.getStart(source)} ${guard} ${JSON.stringify(value)}`);
      return;
    }
    edits.push({ start, end, replacement: out });
  };

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) consider(node);
    else if (ts.isTemplateExpression(node)) {
      consider(node.head);
      for (const span of node.templateSpans) consider(span.literal);
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
  const anchor = '\n  };\n\n  const table';
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
