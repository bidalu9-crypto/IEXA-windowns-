'use strict';
// Every tool the model can call must present itself the same way: one stable
// name, one distinct icon, and a summary that describes the call. A duplicate
// icon or a missing label is what made different calls look identical.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/renderer/services/ToolStreamView.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');

/** Pull a `const NAME = { ... }` literal out of the renderer source. */
function objectLiteral(name) {
  const start = source.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `${name} is declared`);
  const end = source.indexOf('\n};', start);
  assert.ok(end > start, `${name} is closed`);
  const body = source.slice(start, end);
  const entries = {};
  for (const match of body.matchAll(/^\s*([a-z0-9_]+):\s*'([^']+)',?$/gim)) entries[match[1]] = match[2];
  return entries;
}

/** Labels live in the i18n table, so every tool needs a `tool.<id>` row there. */
function loadUiDictionary() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'src/renderer/services/I18nUi.js'), 'utf8'), sandbox, { filename: 'I18nUi.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/renderer/services/I18nUiPanels.js'), 'utf8'), sandbox, { filename: 'I18nUiPanels.js' });
  return sandbox.window.IexaI18nUi;
}

const icons = objectLiteral('TOOL_ICONS');
const aliases = objectLiteral('TOOL_ALIASES');

// DeepSeek Harness gives every call one of seven row variants; the variant,
// not the wire tool, chooses the glyph and the leading verb. Loading the
// renderer in a bare context is enough to reach the classifier.
function loadVariants() {
  const context = {
    window: {},
    document: { documentElement: { getAttribute: () => null }, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: () => {} },
    IexaI18n: { t: (key) => key },
    uiIcon: () => '',
    fetch: () => Promise.reject(new Error('offline')),
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'ToolStreamView.js' });
  return context;
}

const VARIANTS = ['search', 'read', 'bash', 'write', 'edit', 'others'];

// The default registry plus the tools the server registers with runtime deps
// and the ones registered dynamically (vision proxy, MCP, sub-agents).
const REGISTERED = [
  'ask_user', 'browser_fetch', 'desktop_control', 'display_file', 'file_edit',
  'file_read', 'file_write', 'glob', 'grep', 'memory_get', 'memory_write',
  'project_instructions', 'shell_execute', 'todo_write', 'web_search',
  'shell_session', 'job_list', 'job_output', 'goal',
];
const DYNAMIC = ['read_image', 'spawn_agent', 'send_input', 'wait_agent', 'close_agent', 'resume_agent'];
const ALL = [...REGISTERED, ...DYNAMIC];

const UI = loadUiDictionary();
const labels = {};
for (const name of ALL) if (UI.zh['tool.' + name]) labels[name] = UI.zh['tool.' + name];

test('every tool has a label in all three locales', () => {
  const missingLabels = ALL.filter((name) => !labels[name]);
  assert.deepEqual(missingLabels, [], 'tools without a label fall back to their raw id');
  const blank = [];
  for (const name of ALL) {
    for (const locale of ['zh', 'en', 'ja']) {
      const value = UI[locale]['tool.' + name];
      if (typeof value !== 'string' || !value.trim()) blank.push(`${locale}:${name}`);
    }
  }
  assert.deepEqual(blank, [], 'no locale may leave a tool unnamed');
});

test('every tool resolves to one of the seven row variants', () => {
  const context = loadVariants();
  const unknown = [];
  for (const name of ALL) {
    const variant = context.toolVariant(name);
    if (!VARIANTS.includes(variant)) unknown.push(`${name} -> ${variant}`);
  }
  assert.deepEqual(unknown, [], 'a tool that falls outside the variant set gets a mismatched glyph');
  // The classifier must be stable: a wire alias cannot pick a different row.
  assert.equal(context.toolVariant('read_file'), 'read');
  assert.equal(context.toolVariant('edit'), 'edit');
});

test('every variant has a title and a sprite glyph', () => {
  const symbols = new Set([...html.matchAll(/<symbol id="ui-([a-z0-9-]+)"/g)].map((m) => m[1]));
  const missing = VARIANTS.filter((variant) => !symbols.has('tool-variant-' + variant));
  assert.deepEqual(missing, [], 'a variant without a glyph falls back to a blank icon');
  const blankTitles = VARIANTS.filter((variant) => {
    for (const locale of ['zh', 'en', 'ja']) {
      const value = UI[locale]['tool.variant.' + variant];
      if (typeof value !== 'string' || !value.trim()) return true;
    }
    return false;
  });
  assert.deepEqual(blankTitles, [], 'a variant must be named in all three locales');
});

test('every referenced icon exists in the sprite', () => {
  const symbols = new Set([...html.matchAll(/<symbol id="ui-([a-z0-9-]+)"/g)].map((m) => m[1]));
  for (const [name, icon] of Object.entries(icons)) {
    assert.ok(symbols.has(icon), `${name} points at a missing symbol #ui-${icon}`);
  }
});

test('aliases resolve to a real tool', () => {
  for (const [alias, canonical] of Object.entries(aliases)) {
    assert.ok(ALL.includes(canonical), `${alias} maps to unknown ${canonical}`);
    assert.ok(!ALL.includes(alias), `${alias} is also a real tool name`);
  }
});

test('presentation helpers canonicalise aliases and cover the families', () => {
  assert.match(source, /function canonicalToolName\(name\)/);
  assert.match(source, /const canonical = canonicalToolName\(name\);\s*\n\s*if \(canonical\.startsWith\('mcp_'\)\) return 'MCP · '/,
    'MCP tools keep a readable suffix');
  assert.match(source, /if \(canonical\.startsWith\('mcp_'\)\) return uiIcon\('tool-variant-others'\)/);
  assert.match(source, /'web_search', 'job_list'\]\.includes\(canonical\)/, 'web_search is classified as a search tool');
  assert.match(source, /'job_output', 'memory_get'\]\.includes\(canonical\)/, 'display_file is classified as a read tool');
});

test('the renderer never falls back to a gear for a known tool', () => {
  assert.doesNotMatch(source, /TOOL_ICONS\[[^\]]+\] \|\| 'settings'/, 'the old gear fallback is gone');
  assert.match(source, /uiIcon\(VARIANT_ICONS\[toolVariant\(canonical\)\]\)/, 'the fallback is the neutral variant glyph');
});

test('every registered definition is well formed', () => {
  const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');
  const runtime = new ToolRuntime({ workspaceDir: root, memoryDir: path.join(root, 'memory'), permissionMode: 'full' });
  runtime.registerDefaults();
  const definitions = runtime.registry.list();
  assert.ok(definitions.length >= 15, 'the default registry is populated');
  const names = new Set();
  for (const definition of definitions) {
    assert.match(definition.name, /^[a-z][a-z0-9_]*$/, `${definition.name} is a valid tool id`);
    assert.ok(!names.has(definition.name), `${definition.name} is registered twice`);
    names.add(definition.name);
    assert.ok(String(definition.description || '').length >= 20, `${definition.name} has a usable description`);
    assert.ok(Object.keys(definition.parameters || {}).length > 0, `${definition.name} declares parameters`);
    for (const required of definition.required || []) {
      assert.ok(definition.parameters[required], `${definition.name}.${required} is required but not declared`);
    }
  }
  for (const name of definitions.map((definition) => definition.name)) {
    assert.ok(labels[name], `${name} is registered but has no label`);
    assert.ok(icons[name], `${name} is registered but has no icon`);
  }
});
