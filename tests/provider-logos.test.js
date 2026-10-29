'use strict';
// Provider avatars wear the vendor's own mark. Most gateway profiles are stored
// as provider=openai while serving DeepSeek/Qwen/Gemini models, so the resolver
// has to read the model name and base URL before falling back to the provider.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const source = fs.readFileSync(path.join(RENDERER, 'services', 'ProviderLogos.js'), 'utf8');

function load() {
  const sandbox = { uiIcon: (name) => '<svg class="ui-icon" data-icon="' + name + '"></svg>' };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'ProviderLogos.js' });
  return sandbox.IexaProviderLogos;
}

test('the provider field alone decides when the model is generic', () => {
  const logos = load();
  assert.equal(logos.key('anthropic', { model: 'claude-opus-4-8', baseURL: '' }), 'anthropic');
  assert.equal(logos.key('openai', { model: 'gpt-5-astra', baseURL: '' }), 'openai');
  assert.equal(logos.key('gemini', { model: 'gemini-2.5-pro', baseURL: '' }), 'gemini');
  assert.equal(logos.key('deepseek', { model: 'deepseek-v4.1-flash', baseURL: '' }), 'deepseek');
  assert.equal(logos.key('openrouter', { model: 'anything', baseURL: '' }), 'openrouter');
  assert.equal(logos.key('xai', { model: 'grok-4', baseURL: '' }), 'xai');
});

test('a gateway registered as openai wears the model vendor instead', () => {
  const logos = load();
  assert.equal(logos.key('openai', { model: 'EvanShine-deepseek-v4.1-flash', baseURL: 'https://web2api.bilinb666.site' }), 'deepseek');
  assert.equal(logos.key('openai', { model: 'qwen3-max', baseURL: '' }), 'qwen');
  assert.equal(logos.key('openai', { model: 'gemini-3.0-flash', baseURL: '' }), 'gemini');
  assert.equal(logos.key('openai', { model: 'kimi-k2', baseURL: '' }), 'moonshot');
  assert.equal(logos.key('custom', { model: '', baseURL: 'https://openrouter.ai/api/v1' }), 'openrouter');
});

test('an unknown gateway falls back to a neutral glyph', () => {
  const logos = load();
  assert.equal(logos.key('custom', { model: 'some-private-model', baseURL: 'http://10.0.0.5:8000' }), 'custom');
  assert.equal(logos.markup('custom', { model: '', baseURL: '' }), '<svg class="ui-icon" data-icon="box"></svg>');
  assert.equal(logos.svg('custom'), '');
});

test('every mark is a well-formed 24x24 path', () => {
  const logos = load();
  for (const name of logos.names) {
    const svg = logos.svg(name);
    assert.match(svg, /^<svg class="provider-logo" data-provider="[a-z]+" viewBox="0 0 24 24"/, name + ' opens correctly');
    assert.match(svg, /<path d="[Mm][^"]{40,}"/, name + ' has a real path');
    assert.match(svg, /<\/svg>$/, name + ' closes');
    assert.equal((svg.match(/<path/g) || []).length, 1, name + ' is a single path');
  }
});

test('the resolver never trusts a provider prefix that contradicts the model', () => {
  const logos = load();
  for (const [provider, model, expected] of [
    ['openai', 'claude-3-7-sonnet', 'anthropic'],
    ['anthropic', 'gpt-4o', 'openai'],
    ['gemini', 'deepseek-r2', 'deepseek'],
    ['xai', 'qwen2.5-max', 'qwen'],
  ]) {
    assert.equal(logos.key(provider, { model, baseURL: '' }), expected, provider + '/' + model);
  }
});
