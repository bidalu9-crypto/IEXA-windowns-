// The chart protocol is the only gate between model-generated JSON and the SVG
// renderer, so every rejection path is pinned here. The module is a classic
// renderer script, so it is evaluated in a vm with a minimal window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/services/ChartSpec.js'), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const { validateChartSpec, parseChartSpec, valueRange } = sandbox.window.IexaChartSpec;

/** Values created inside the vm carry its Array prototype; copy them here. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const base = () => ({
  type: 'line',
  title: '响应时间',
  categories: ['a', 'b', 'c'],
  series: [{ name: 'p50', values: [1, 2, 3] }],
});

test('a valid line chart is normalised, not passed through', () => {
  const result = validateChartSpec({ ...base(), title: '  响应\n时间  ' });
  assert.equal(result.ok, true);
  assert.equal(result.spec.type, 'line');
  // Newlines collapse so a label can never break the layout.
  assert.equal(result.spec.title, '响应 时间');
  assert.deepEqual(plain(result.spec.categories), ['a', 'b', 'c']);
  assert.deepEqual(plain(result.spec.series[0].values), [1, 2, 3]);
});

test('a bar chart accepts integers and numeric strings', () => {
  const result = validateChartSpec({ ...base(), type: 'BAR', series: [{ name: 'x', values: ['1', 2, 3.5] }] });
  assert.equal(result.ok, true);
  assert.equal(result.spec.type, 'bar');
  assert.deepEqual(plain(result.spec.series[0].values), [1, 2, 3.5]);
});

test('missing or illegal shape is refused with a readable message', () => {
  const cases = [
    [null, /JSON 对象/],
    [[], /JSON 对象/],
    [{ ...base(), type: 'pie' }, /不支持的图表类型/],
    [{ ...base(), categories: [] }, /缺少 categories/],
    [{ ...base(), categories: undefined }, /缺少 categories/],
    [{ ...base(), categories: ['a', ''] }, /空标签/],
    [{ ...base(), series: [] }, /缺少 series/],
    [{ ...base(), series: [{ name: 'x' }] }, /缺少 values/],
  ];
  for (const [input, pattern] of cases) {
    const result = validateChartSpec(input);
    assert.equal(result.ok, false, 'should reject: ' + JSON.stringify(input));
    assert.match(result.error, pattern);
  }
});

test('a series whose length does not match the axis is refused', () => {
  const result = validateChartSpec({ ...base(), series: [{ name: 'p50', values: [1, 2] }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /3 个分类/);
});

test('non-finite values are refused for bars, and become gaps for lines', () => {
  const bar = validateChartSpec({ ...base(), type: 'bar', series: [{ name: 'x', values: [1, null, 3] }] });
  assert.equal(bar.ok, false);
  assert.match(bar.error, /不是有限数值/);

  const line = validateChartSpec({ ...base(), series: [{ name: 'x', values: [1, null, 3] }] });
  assert.equal(line.ok, true);
  // null means "no sample here"; the renderer breaks the line instead of
  // pretending the value was zero.
  assert.deepEqual(plain(line.spec.series[0].values), [1, null, 3]);
});

test('oversized input is refused before it reaches the renderer', () => {
  const manyCategories = Array.from({ length: 501 }, (_, i) => 'c' + i);
  assert.match(validateChartSpec({ ...base(), categories: manyCategories, series: [{ name: 'x', values: manyCategories.map(() => 1) }] }).error, /横轴分类过多/);

  const manySeries = Array.from({ length: 9 }, (_, i) => ({ name: 's' + i, values: [1, 2, 3] }));
  assert.match(validateChartSpec({ ...base(), series: manySeries }).error, /数据系列过多/);

  const wide = Array.from({ length: 400 }, (_, i) => 'c' + i);
  const series = Array.from({ length: 8 }, (_, i) => ({ name: 's' + i, values: wide.map(() => i) }));
  assert.match(validateChartSpec({ ...base(), categories: wide, series }).error, /数据点过多/);

  assert.match(validateChartSpec({ ...base(), series: [{ name: 'x', values: [1e13, 2, 3] }] }).error, /超出范围/);
});

test('an all-zero bar chart is refused instead of drawing an empty frame', () => {
  const result = validateChartSpec({ ...base(), type: 'bar', series: [{ name: 'x', values: [0, 0, 0] }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /都是 0/);
});

test('long text is truncated rather than rejected', () => {
  const result = validateChartSpec({ ...base(), title: 'T'.repeat(400), note: 'N'.repeat(900) });
  assert.equal(result.ok, true);
  assert.ok(result.spec.title.length <= 201);
  assert.ok(result.spec.note.length <= 501);
});

test('parse reports a JSON error without leaking a stack', () => {
  // Balanced but malformed: an incomplete body is a different case (see the
  // mid-value test below), so this one must still surface a real error.
  const broken = parseChartSpec('{ "type": "line", }');
  assert.equal(broken.ok, false);
  assert.match(broken.error, /JSON 解析失败/);
  assert.doesNotMatch(broken.error, /at Object|node_modules/);

  assert.equal(parseChartSpec('').ok, false);
  assert.equal(parseChartSpec('   ').ok, false);
});

test('a body that stops mid-value is reported as incomplete, not as an error', () => {
  // Mid-stream frames look exactly like this. Treating them as errors flashed a red
  // banner on every frame of a normal stream.
  const partials = [
    '{"type":"line","title":"未完成","cate',
    '{"type":"line","title":"x","categories":["a","b"]',
    '{"type":"line","categories":["a"],"series":[{"name":"s","values":[1,2',
    '{"type":"bar"',
  ];
  for (const partial of partials) {
    const result = parseChartSpec(partial);
    assert.equal(result.ok, false, partial);
    assert.equal(result.incomplete, true, `should be incomplete: ${partial}`);
  }
  // A body that is balanced but wrong is still an error, not an incomplete frame.
  const broken = parseChartSpec('{"type":"line",}');
  assert.equal(broken.ok, false);
  assert.notEqual(broken.incomplete, true, 'balanced-but-broken JSON is a real error');
  assert.match(broken.error, /JSON/);
});

test('the value range spans every series and ignores gaps', () => {
  const spec = validateChartSpec({
    ...base(),
    series: [{ name: 'a', values: [-4, 0, null] }, { name: 'b', values: [1, 8, 2] }],
  }).spec;
  assert.deepEqual(plain(valueRange(spec)), { min: -4, max: 8 });
});
