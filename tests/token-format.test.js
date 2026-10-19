'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const appSource = require('./helpers/renderer-bundle').source;
const tree = ts.createSourceFile('app.js', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declarations = tree.statements.filter((node) => ts.isFunctionDeclaration(node));
function pick(name) {
  const node = declarations.find((item) => item.name?.text === name);
  assert.ok(node, `missing function ${name}`);
  return node.getText(tree);
}

// The formatter is pure, so it is evaluated on its own instead of pulling the
// whole renderer into a DOM.
const context = {};
new Function('exports', `${pick('formatTokenCount')}\nexports.formatTokenCount = formatTokenCount;`)(context);
const format = context.formatTokenCount;

test('token counts are magnitudes with three significant digits', () => {
  const cases = [
    [0, '0'], [1, '1'], [999, '999'],
    [1000, '1K'], [1198, '1.2K'], [9999, '10K'], [10000, '10K'],
    [80739, '80.7K'], [99999, '100K'], [100000, '100K'],
    [131328, '131K'], [132225, '132K'], [295680, '296K'], [999499, '999K'],
    [1000000, '1M'], [1234567, '1.2M'], [12345678, '12M'],
    [1000000000, '1B'],
  ];
  for (const [input, expected] of cases) assert.equal(format(input), expected, `${input} should read ${expected}`);
});

test('unit promotion happens after rounding, never mid-digit', () => {
  // 999,500 and up would render as "1000K" if the unit were chosen first.
  assert.equal(format(999500), '1M');
  assert.equal(format(999999), '1M');
  assert.equal(format(999999999), '1B');
});

test('missing or hostile input degrades to zero instead of NaN', () => {
  for (const value of [undefined, null, '', 'abc', Number.NaN, -5, -0.4]) {
    assert.equal(format(value), '0', `${String(value)} should read 0`);
  }
  assert.equal(format('1234'), '1.2K', 'numeric strings still format');
});

test('every token surface routes through the shared formatter', () => {
  assert.ok(appSource.includes('function formatContextTokens(tokens) {\n  return formatTokenCount(tokens);'),
    'context ring delegates to the shared rule');
  assert.ok(appSource.includes('function formatUsageNumber(value) {\n  return formatTokenCount(value);'),
    'token page keeps its name but shares the rule');
  assert.ok(appSource.includes('${formatTokenCount(input)} <em>入</em>'), 'message input uses the formatter');
  assert.ok(appSource.includes('${formatTokenCount(output)} <em>出</em>'), 'message output uses the formatter');
  assert.ok(appSource.includes('${formatTokenCount(cache)} <em>缓存</em>'), 'message cache uses the formatter');
  assert.ok(appSource.includes('title="输入 ${input.toLocaleString()} tokens"'), 'exact input stays in the title');
  assert.ok(appSource.includes('title="缓存读取 ${cache.toLocaleString()} tokens"'), 'exact cache stays in the title');
  assert.ok(appSource.includes('countEl.textContent = formatTokenCount(tokens);'), 'thinking badge is compact');
  assert.ok(appSource.includes('约 ${formatTokenCount(count)} tokens'), 'soul editor estimate is compact');
  assert.ok(appSource.includes('${formatTokenCount(currentContextCompactionLimit)} token）'), 'compaction tooltip is compact');
  // The only remaining grouped counts are titles and timestamps.
  const grouped = appSource.match(/\$\{[^}]*\.toLocaleString\(\)\}/g) || [];
  assert.deepEqual(grouped.filter((item) => item.includes('input.toLocaleString') || item.includes('cache.toLocaleString')),
    ['${input.toLocaleString()}', '${cache.toLocaleString()}'],
    'grouped digits survive only where they are hover detail: ' + grouped.join(' '));
});
