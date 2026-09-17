'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BudgetManager } = require('../dist/main/runtime/BudgetManager');

test('budget configuration rejects nonpositive, fractional and nonfinite limits', () => {
  const invalid = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1];
  for (const name of ['maxTurns', 'maxToolCalls', 'maxRuntimeMs', 'maxInputTokens']) {
    for (const value of invalid) assert.throws(() => new BudgetManager({ [name]: value }), /positive safe integer/);
  }
});

test('budget limits remain finite and enforce exact configured boundaries', () => {
  const turns = new BudgetManager({ maxTurns: 2 }); turns.beginTurn(); turns.beginTurn(); assert.throws(() => turns.beginTurn(), /BUDGET_TURNS|最大执行轮数/);
  const tools = new BudgetManager({ maxToolCalls: 2 }); tools.recordTool(); tools.recordTool(); assert.throws(() => tools.recordTool(), /BUDGET_TOOLS|最大工具调用数/);
  const tokens = new BudgetManager({ maxInputTokens: 3 }); tokens.recordInputTokens(1); tokens.recordInputTokens(2); assert.throws(() => tokens.recordInputTokens(1), /BUDGET_TOKENS|上下文预算/);
});

test('input token accounting rejects malformed values', () => {
  const budget = new BudgetManager();
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => budget.recordInputTokens(value), /nonnegative safe integer/);
  assert.doesNotThrow(() => budget.recordInputTokens(0));
});
