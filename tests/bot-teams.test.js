'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: tick } = require('node:timers/promises');
const { BotTeams } = require('../dist/main/bots/BotTeams');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const plan = ids => JSON.stringify({ tasks: ids.map(botId => ({ botId, instruction: `work-${botId}` })) });
function fixture(t, runner) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-bot-teams-'));
  const bots = new Map(['a', 'b', 'c', 'd', 'e'].map(id => [id, { id, name: id, description: `description-${id}`, persona: '', memory: '', profileId: 'fixture', created: 1, updated: 1 }]));
  const calls = [];
  const deps = { getBot: id => bots.get(id), run: async (...args) => {
    calls.push({ botId: args[0], prompt: args[1], signal: args[2], planning: args[3] });
    await tick(); // Actual async fixture runner; never calls a model or server.
    return runner(...args);
  } };
  const teams = new BotTeams(root, deps);
  t.after(async () => { await teams.stopAll(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { teams, calls, root, deps };
}
async function until(predicate, message = 'fixture condition') {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail(`Timed out: ${message}`);
}
const terminal = status => ['completed', 'cancelled', 'failed', 'interrupted'].includes(status);

test('synchronous start, strict plan order, bounded handoff, sessions and persistent deep copies', async t => {
  let active = 0, maximum = 0;
  const { teams, calls, root } = fixture(t, async (id, prompt, signal, planning, onSession) => {
    active++; maximum = Math.max(maximum, active);
    await tick();
    if (planning) { active--; return plan(['b', 'a']); }
    onSession('session-' + id);
    active--;
    return id === 'b' ? 'FIRST_RESULT:' + 'x'.repeat(50000) : 'SECOND_RESULT';
  });
  const started = teams.start('shared-goal', ['a', 'b']);
  assert.equal(started.status, 'planning');
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'teams.json'), 'utf8')).teams[0].status, 'planning');
  started.botIds.push('corrupt'); started.goal = 'changed';
  await until(() => terminal(teams.get(started.id).status));
  assert.equal(maximum, 1);
  assert.deepEqual(calls.map(c => [c.botId, c.planning]), [['a', true], ['b', false], ['a', false]]);
  assert.match(calls[0].prompt, /不使用任何工具/);
  assert.match(calls[1].prompt, /shared-goal/);
  assert.match(calls[1].prompt, /work-b/);
  assert.doesNotMatch(calls[1].prompt, /FIRST_RESULT/);
  assert.match(calls[2].prompt, /FIRST_RESULT/);
  assert.match(calls[2].prompt, /work-a/);
  assert.match(calls[2].prompt, /"truncated":true/);
  assert.ok(calls[2].prompt.length < 25000);
  const team = teams.get(started.id);
  assert.equal(team.status, 'completed');
  assert.deepEqual(team.tasks.map(task => [task.botId, task.status, task.sessionId]), [['b', 'completed', 'session-b'], ['a', 'completed', 'session-a']]);
  assert.equal(team.tasks[0].result.length, 50013, 'stored result is complete; only handoff is bounded');
  team.plan.tasks[0].instruction = 'mutated'; team.tasks[0].result = 'mutated';
  const listed = teams.list(); listed[0].botIds.length = 0;
  assert.equal(teams.get(started.id).plan.tasks[0].instruction, 'work-b');
  assert.equal(teams.get(started.id).botIds.length, 2);
  assert.deepEqual(new BotTeams(root, { getBot() {}, async run() { assert.fail('must not replay'); } }).get(started.id), teams.get(started.id));
});

test('invalid plans explicitly fail without any execution fallback', async t => {
  const invalid = [
    'not json', '```json\n' + plan(['a', 'b']) + '\n```', 'null', '{}',
    plan(['a']), plan(['a', 'a']), plan(['a', 'unknown']), plan(['a', 'b', 'c', 'd', 'e']),
    JSON.stringify({ tasks: [{ botId: 'a', instruction: '' }, { botId: 'b', instruction: 'ok' }] }),
    JSON.stringify({ tasks: [{ botId: 'a', instruction: 'x'.repeat(16001) }, { botId: 'b', instruction: 'ok' }] }),
  ];
  for (const output of invalid) {
    await t.test(output.slice(0, 50), async t => {
      const { teams, calls } = fixture(t, async () => output);
      const team = teams.start('goal', ['a', 'b']);
      await until(() => teams.get(team.id).status === 'failed');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].planning, true);
      assert.ok(teams.get(team.id).error);
      assert.deepEqual(teams.get(team.id).tasks, []);
    });
  }
});

test('cancel persists cancelling, aborts and waits for runner settlement before cancelled', async t => {
  const started = deferred(), finish = deferred();
  const { teams, calls, root } = fixture(t, async (id, prompt, signal, planning, onSession) => {
    if (planning) return plan(['a', 'b']);
    onSession('active-session'); started.resolve(signal);
    return finish.promise;
  });
  const team = teams.start('goal', ['a', 'b']);
  const signal = await started.promise;
  let returned = false;
  const cancelled = teams.cancel(team.id).then(value => { returned = true; return value; });
  assert.equal(signal.aborted, true);
  await tick();
  assert.equal(returned, false);
  assert.equal(teams.get(team.id).status, 'cancelling');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'teams.json'), 'utf8')).teams[0].status, 'cancelling');
  finish.resolve('late result');
  assert.equal((await cancelled).status, 'cancelled');
  assert.equal(calls.length, 2, 'no second work task');
  assert.deepEqual(teams.get(team.id).tasks.map(task => task.status), ['cancelled', 'cancelled']);
  assert.equal(teams.get(team.id).tasks[0].sessionId, 'active-session');
  assert.equal((await teams.cancel(team.id)).status, 'cancelled');
});

test('cancellation during planning never starts tasks; immediate cancel never starts planning', async t => {
  const planning = deferred(), finish = deferred();
  const { teams, calls } = fixture(t, async () => { planning.resolve(); return finish.promise; });
  const first = teams.start('goal', ['a', 'b']);
  await planning.promise;
  const cancelled = teams.cancel(first.id);
  assert.equal(teams.get(first.id).status, 'cancelling');
  finish.reject(new Error('aborted fixture'));
  assert.equal((await cancelled).status, 'cancelled');
  assert.equal(calls.length, 1);
  const second = teams.start('another', ['a', 'b']);
  assert.equal((await teams.cancel(second.id)).status, 'cancelled');
  assert.equal(calls.length, 1);
});

test('validates goals and Bot sets synchronously and limits active teams including cancellation', async t => {
  const finish = deferred();
  const { teams } = fixture(t, async () => finish.promise);
  for (const goal of ['', '  ', 'x'.repeat(16001), null]) assert.throws(() => teams.start(goal, ['a', 'b']));
  for (const ids of [[], ['a'], ['a', 'a'], ['a', 'b', 'c', 'd', 'e'], ['a', 'missing'], ['a', 2], null]) {
    assert.throws(() => teams.start('goal', ids));
  }
  const a = teams.start('x', ['a', 'b']);
  teams.start('x'.repeat(16000), ['a', 'b', 'c', 'd']);
  await tick();
  const cancelling = teams.cancel(a.id);
  assert.throws(() => teams.start('third', ['a', 'b']), /2/);
  const stopping = teams.stopAll();
  finish.resolve(plan(['a', 'b']));
  await Promise.all([cancelling, stopping]);
  assert.ok(teams.list().every(team => team.status === 'cancelled'));
  const next = teams.start('new', ['a', 'b']);
  await teams.cancel(next.id);
  await assert.rejects(teams.cancel('missing'), /不存在/);
  assert.equal(teams.get('missing'), undefined);
});

test('task errors persist session and failure without launching later tasks', async t => {
  const { teams, calls } = fixture(t, async (id, prompt, signal, planning, onSession) => {
    if (planning) return plan(['b', 'a']);
    onSession('failed-session');
    throw new Error('fixture task failed');
  });
  const team = teams.start('goal', ['a', 'b']);
  await until(() => teams.get(team.id).status === 'failed');
  const result = teams.get(team.id);
  assert.equal(result.error, 'fixture task failed');
  assert.equal(result.tasks[0].error, 'fixture task failed');
  assert.equal(result.tasks[0].status, 'failed');
  assert.equal(result.tasks[0].sessionId, 'failed-session');
  assert.equal(result.tasks[1].status, 'pending');
  assert.equal(calls.length, 2);
});

test('restart marks every nonterminal team interrupted and never replays persisted work', async t => {
  const { root, teams } = fixture(t, async () => assert.fail('no work expected'));
  const states = ['planning', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'];
  const saved = states.map((status, i) => ({ id: 'saved-' + i, goal: 'goal', botIds: ['a', 'b'], status, created: 1, updated: 1,
    tasks: [{ botId: 'a', instruction: 'first', status: status === 'planning' ? 'pending' : 'running', sessionId: 'old-session' },
      { botId: 'b', instruction: 'second', status: 'pending' }] }));
  fs.writeFileSync(path.join(root, 'teams.json'), JSON.stringify({ teams: saved }));
  let calls = 0;
  const restored = new BotTeams(root, { getBot() {}, async run() { calls++; throw new Error('replayed'); } });
  await tick();
  assert.equal(calls, 0);
  assert.deepEqual(restored.list().map(team => team.status), ['interrupted', 'interrupted', 'interrupted', 'completed', 'failed', 'cancelled', 'interrupted']);
  for (const team of restored.list().slice(0, 3)) {
    assert.ok(team.error.includes('不会自动重放'));
    assert.ok(team.updated > 1);
    assert.ok(team.tasks.every(task => task.status === 'interrupted'));
    assert.equal(team.tasks[0].sessionId, 'old-session');
  }
  const disk = JSON.parse(fs.readFileSync(path.join(root, 'teams.json'), 'utf8'));
  assert.deepEqual(disk.teams, restored.list());
  await restored.stopAll();
  assert.equal(calls, 0);
  assert.equal(teams.list().length, 0);
});
