/* Chart data protocol.
   A chart is a fenced ```chart block whose body is JSON. Parsing and validation
   live here so the renderer can stay dumb: it only ever draws numbers that have
   already passed these checks. Nothing here touches the DOM, so the protocol can
   be unit-tested without a browser.

   Hard limits exist because the input is model-generated: an unbounded series
   count would let one reply freeze the transcript. */
(() => {
  'use strict';

  const TYPES = ['line', 'bar'];
  const MAX_CATEGORIES = 500;
  const MAX_SERIES = 8;
  // Below the 500×8 product on purpose: a cap that the other two limits already
  // make unreachable would be dead code.
  const MAX_POINTS = 2400;
  const MAX_MAGNITUDE = 1e12;
  const LIMITS = {
    title: 200, label: 120, unit: 16, name: 64, category: 64, note: 500,
  };

  /** Short, single-line text: strips newlines so a label cannot break the layout. */
  function text(value, limit) {
    if (value === undefined || value === null) return '';
    const flat = String(value).replace(/\s+/g, ' ').trim();
    return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
  }

  function fail(error) { return { ok: false, error }; }

  function number(value) {
    // Only numbers and non-empty numeric strings are data. `null`, booleans and
    // objects are *not* 0: silently coercing them would draw a value that the
    // model never provided.
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
  }

  /**
   * Validate an already-parsed object.
   * Returns { ok: true, spec } with every field normalised, or { ok: false, error }
   * carrying a message meant for the user, never a stack trace.
   */
  function validateChartSpec(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('图表数据必须是一个 JSON 对象');
    const type = String(raw.type || '').toLowerCase();
    if (!TYPES.includes(type)) return fail(`不支持的图表类型：${text(raw.type, 40) || '(空)'}；目前支持 line 与 bar`);

    const categories = Array.isArray(raw.categories) ? raw.categories : null;
    if (!categories || !categories.length) return fail('缺少 categories（横轴分类）');
    if (categories.length > MAX_CATEGORIES) return fail(`横轴分类过多（${categories.length} > ${MAX_CATEGORIES}）`);

    const labels = categories.map((item) => text(item, LIMITS.category));
    if (labels.some((label) => !label)) return fail('categories 里有空标签');

    const series = Array.isArray(raw.series) ? raw.series : null;
    if (!series || !series.length) return fail('缺少 series（数据系列）');
    if (series.length > MAX_SERIES) return fail(`数据系列过多（${series.length} > ${MAX_SERIES}）`);

    const normalizedSeries = [];
    for (let index = 0; index < series.length; index += 1) {
      const item = series[index];
      if (!item || typeof item !== 'object') return fail(`第 ${index + 1} 个系列不是对象`);
      const name = text(item.name, LIMITS.name) || `系列 ${index + 1}`;
      const values = Array.isArray(item.values) ? item.values : null;
      if (!values) return fail(`系列「${name}」缺少 values 数组`);
      if (values.length !== labels.length) {
        return fail(`系列「${name}」有 ${values.length} 个值，但横轴有 ${labels.length} 个分类`);
      }
      const numbers = [];
      for (let point = 0; point < values.length; point += 1) {
        const value = number(values[point]);
        // null is meaningful for a line chart: it breaks the line instead of
        // pretending the value is zero.
        if (value === null) {
          if (type === 'bar') return fail(`系列「${name}」第 ${point + 1} 个值不是有限数值`);
          numbers.push(null);
          continue;
        }
        if (Math.abs(value) > MAX_MAGNITUDE) return fail(`系列「${name}」第 ${point + 1} 个值超出范围`);
        numbers.push(value);
      }
      normalizedSeries.push({ name, values: numbers });
    }

    if (labels.length * normalizedSeries.length > MAX_POINTS) {
      return fail(`数据点过多（${labels.length * normalizedSeries.length} > ${MAX_POINTS}）`);
    }
    if (type === 'bar' && normalizedSeries.every((item) => item.values.every((value) => value === 0))) {
      return fail('柱状图的所有数值都是 0');
    }

    return {
      ok: true,
      spec: {
        type,
        title: text(raw.title, LIMITS.title),
        xLabel: text(raw.xLabel, LIMITS.label),
        yLabel: text(raw.yLabel, LIMITS.label),
        unit: text(raw.unit, LIMITS.unit),
        note: text(raw.note, LIMITS.note),
        categories: labels,
        series: normalizedSeries,
      },
    };
  }

  /**
   * A body that stops mid-value is a streaming artefact, not a user error. Draw
   * nothing and leave the block as plain text: a red "cannot display" banner
   * flashing on every frame of a normal stream would be noise.
   */
  function looksIncomplete(source) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (const character of source) {
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{' || character === '[') depth += 1;
      else if (character === '}' || character === ']') depth -= 1;
    }
    return inString || depth > 0;
  }

  /** Parse the raw text of a ```chart block. Partial JSON is a normal case mid-stream. */
  function parseChartSpec(source) {
    const body = String(source || '').trim();
    if (!body) return fail('图表内容为空');
    let raw;
    try {
      raw = JSON.parse(body);
    } catch (error) {
      if (looksIncomplete(body)) return { ok: false, incomplete: true, error: '图表数据尚未输出完整' };
      return fail('图表 JSON 解析失败：' + text(error && error.message, 120));
    }
    return validateChartSpec(raw);
  }

  /** Every finite value across all series, for the axis range. */
  function valueRange(spec) {
    let min = Infinity;
    let max = -Infinity;
    for (const series of spec.series) {
      for (const value of series.values) {
        if (value === null) continue;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
    if (min === max) return min === 0 ? { min: 0, max: 1 } : { min: Math.min(0, min), max };
    return { min, max };
  }

  window.IexaChartSpec = Object.freeze({
    TYPES, LIMITS, MAX_CATEGORIES, MAX_SERIES, MAX_POINTS,
    parseChartSpec, validateChartSpec, valueRange,
  });
})();
