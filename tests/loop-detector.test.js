'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LoopDetector } = require('../dist/main/runtime/LoopDetector');

test('loop detector canonicalizes nested object key order', () => {
  const detector = new LoopDetector(2, 6);
  detector.record('fixture', { a: 1, nested: { x: 2, y: 3 } });
  detector.record('fixture', { nested: { y: 3, x: 2 }, a: 1 });
  assert.throws(() => detector.record('fixture', { nested: { x: 2, y: 3 }, a: 1 }), /LOOP_DETECTED|重复调用/);
});

test('loop detector preserves array order and validates configuration', () => {
  const detector = new LoopDetector(1, 3);
  detector.record('fixture', { values: [1, 2] });
  assert.doesNotThrow(() => detector.record('fixture', { values: [2, 1] }));
  assert.throws(() => detector.record('fixture', { values: [1, 2] }), /LOOP_DETECTED|重复调用/);
  assert.throws(() => new LoopDetector(0, 3), /LOOP_CONFIG|invalid/);
  assert.throws(() => new LoopDetector(3, 3), /LOOP_CONFIG|invalid/);
});
