#!/usr/bin/env node
/**
 * i18n audit: find Chinese string literals that never reach IexaI18n.
 *
 * A regex over the source counts comments and data tables, so this walks the
 * TypeScript AST instead and only reports real string literals. Dictionary
 * files are excluded — they are where the Chinese is supposed to live.
 *
 * Usage:
 *   node scripts/i18n-audit.cjs list [file-filter...]
 *   node scripts/i18n-audit.cjs dump <file-filter...>
 *   node scripts/i18n-audit.cjs check
 *
 * A line carrying `i18n-exempt` is skipped: some Chinese belongs to a regex,
 * a model prompt or a locale-detection heuristic and must not be translated.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const CJK = /[\u4e00-\u9fa5]/;
const DICTIONARIES = new Set(['services/I18nUi.js', 'services/I18nUiPanels.js', 'services/I18n.js']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'vendor') walk(full, out);
      continue;
    }
    if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function scan(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const hits = [];
  const record = (value, pos) => {
    if (!CJK.test(value)) return;
    const line = source.getLineAndCharacterOfPosition(pos).line;
    if (/i18n-exempt/.test(lines[line] || '')) return;
    hits.push({ value, line: line + 1 });
  };
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) record(node.text, node.getStart(source));
    else if (ts.isTemplateExpression(node)) {
      record(node.head.text, node.head.getStart(source));
      for (const span of node.templateSpans) record(span.literal.text, span.literal.getStart(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function analyse() {
  const rows = [];
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (DICTIONARIES.has(rel)) continue;
    const hits = scan(file);
    if (!hits.length) continue;
    rows.push({ rel, hits, lines: fs.readFileSync(file, 'utf8').split('\n').length });
  }
  rows.sort((a, b) => b.hits.length - a.hits.length);
  return rows;
}

const [mode = 'list', ...filters] = process.argv.slice(2);
const rows = analyse();

if (mode === 'list') {
  const shown = filters.length ? rows.filter((r) => filters.some((f) => r.rel.includes(f))) : rows;
  let total = 0;
  for (const row of shown) {
    total += row.hits.length;
    const unique = new Set(row.hits.map((h) => h.value)).size;
    console.log(`${String(row.hits.length).padStart(4)} ${String(unique).padStart(4)}u ${String(row.lines).padStart(5)}L  ${row.rel}`);
  }
  console.log(`total ${total} literal(s) in ${shown.length} file(s)`);
} else if (mode === 'dump') {
  for (const row of rows) {
    if (!filters.some((f) => row.rel.includes(f))) continue;
    console.log(`\n### ${row.rel} (${row.hits.length}, ${new Set(row.hits.map((h) => h.value)).size} unique)`);
    for (const hit of row.hits) console.log(`${String(hit.line).padStart(4)}| ${hit.value}`);
  }
} else if (mode === 'check') {
  const total = rows.reduce((sum, row) => sum + row.hits.length, 0);
  if (!total) {
    console.log('i18n audit: clean');
    process.exit(0);
  }
  for (const row of rows.slice(0, 20)) console.log(`${String(row.hits.length).padStart(4)}  ${row.rel}`);
  console.log(`i18n audit: ${total} literal(s) still hard-coded in ${rows.length} file(s)`);
  process.exit(1);
} else {
  console.error('unknown mode: ' + mode);
  process.exit(2);
}
