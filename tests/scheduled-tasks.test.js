'use strict';
// Scheduled tasks: wall-clock math, durable storage, the runner and the REST
// surface. The daily/weekly/monthly cases pin real local dates so a DST change
// or a short month cannot silently shift a task.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const { nextRunAfter, normalizeSchedule, describeSchedule, loadScheduledTasks, saveScheduledTasks } = require('../dist/main/tasks/ScheduledTasks');
const { TaskScheduler } = require('../dist/main/tasks/Scheduler');

const at = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

test('daily schedules fire at the next wall-clock time, never the same one twice', () => {
  const schedule = { frequency: 'daily', time: '09:00' };
  assert.equal(nextRunAfter(schedule, at(2026, 3, 10, 8, 59)), at(2026, 3, 10, 9, 0));
  assert.equal(nextRunAfter(schedule, at(2026, 3, 10, 9, 0)), at(2026, 3, 11, 9, 0));
  assert.equal(nextRunAfter(schedule, at(2026, 3, 31, 23, 30)), at(2026, 4, 1, 9, 0));
  assert.equal(nextRunAfter(schedule, at(2026, 12, 31, 23, 30)), at(2027, 1, 1, 9, 0));
});

test('weekly schedules land on the chosen weekday, today only if still ahead', () => {
  // 2026-03-10 is a Tuesday.
  const schedule = { frequency: 'weekly', time: '18:30', weekday: 2 };
  assert.equal(nextRunAfter(schedule, at(2026, 3, 10, 8, 0)), at(2026, 3, 10, 18, 30));
  assert.equal(nextRunAfter(schedule, at(2026, 3, 10, 19, 0)), at(2026, 3, 17, 18, 30));
  // Sunday is 0, not 7.
  assert.equal(nextRunAfter({ frequency: 'weekly', time: '07:00', weekday: 0 }, at(2026, 3, 10, 9, 0)), at(2026, 3, 15, 7, 0));
});

test('monthly schedules clamp to the last day of shorter months', () => {
  const schedule = { frequency: 'monthly', time: '10:00', dayOfMonth: 31 };
  assert.equal(nextRunAfter(schedule, at(2026, 1, 5, 0, 0)), at(2026, 1, 31, 10, 0));
  // February 2026 has 28 days.
  assert.equal(nextRunAfter(schedule, at(2026, 1, 31, 11, 0)), at(2026, 2, 28, 10, 0));
  assert.equal(nextRunAfter(schedule, at(2026, 2, 28, 11, 0)), at(2026, 3, 31, 10, 0));
  assert.equal(nextRunAfter({ frequency: 'monthly', time: '10:00', dayOfMonth: 1 }, at(2026, 12, 15, 0, 0)), at(2027, 1, 1, 10, 0));
});

test('invalid schedules are rejected with a message the editor can show', () => {
  assert.throws(() => normalizeSchedule({ frequency: 'daily', time: '25:00' }), /HH:mm/);
  assert.throws(() => normalizeSchedule({ frequency: 'weekly', time: '09:00', weekday: 7 }), /星期/);
  assert.throws(() => normalizeSchedule({ frequency: 'monthly', time: '09:00', dayOfMonth: 0 }), /1–31/);
  assert.deepEqual(normalizeSchedule({ frequency: 'weekly', time: '09:05', weekday: 3 }), { frequency: 'weekly', time: '09:05', weekday: 3 });
  assert.equal(describeSchedule({ frequency: 'weekly', time: '09:05', weekday: 3 }), '每周周三 09:05');
  assert.equal(describeSchedule({ frequency: 'monthly', time: '21:00', dayOfMonth: 2 }), '每月 2 日 21:00');
});

test('the store survives a restart and keeps only well-formed rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-task-store-'));
  const file = path.join(dir, 'tasks.json');
  const tasks = [{ id: 'task_1', title: '早报', prompt: '汇总', profileId: 'p', sessionMode: 'new', schedule: { frequency: 'daily', time: '09:00' }, enabled: true, createdAt: 1, updatedAt: 1, nextRunAt: 2, runCount: 0 }];
  saveScheduledTasks(file, tasks);
  assert.deepEqual(loadScheduledTasks(file).map((task) => task.id), ['task_1']);
  fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: [null, { nope: true }] }));
  assert.deepEqual(loadScheduledTasks(file), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a due task runs through the host and rolls to its next slot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-task-run-'));
  const sent = [];
  let now = at(2026, 3, 10, 8, 59);
  const scheduler = new TaskScheduler({
    file: path.join(dir, 'tasks.json'),
    now: () => now,
    host: {
      createSession: async ({ title }) => { sent.push(['create', title]); return 'sess_new'; },
      bindSession: () => {},
      sendPrompt: async (sessionId, prompt) => { sent.push(['send', sessionId, prompt]); },
    },
  });
  scheduler.create({ title: '早报', prompt: '汇总今天的变更', profileId: 'p1', schedule: { frequency: 'daily', time: '09:00' } });
  now = at(2026, 3, 10, 9, 0);
  await scheduler.tick();
  assert.deepEqual(sent, [['create', '早报'], ['send', 'sess_new', '汇总今天的变更']]);
  const [task] = scheduler.list();
  assert.equal(task.lastStatus, 'ok');
  assert.equal(task.runCount, 1);
  assert.equal(task.nextRunAt, at(2026, 3, 11, 9, 0), 'next run is tomorrow, not 30 seconds later');
  await scheduler.tick();
  assert.equal(sent.length, 2, 'a second tick must not re-fire the same slot');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a task that was missed while the app was closed is reported, not replayed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-task-missed-'));
  const file = path.join(dir, 'tasks.json');
  let now = at(2026, 3, 10, 9, 0);
  let sent = 0;
  const host = { createSession: async () => 'sess', bindSession: () => {}, sendPrompt: async () => { sent += 1; } };
  const first = new TaskScheduler({ file, now: () => now, host });
  first.create({ prompt: 'run me', profileId: 'p1', schedule: { frequency: 'daily', time: '09:00' } });
  // Close the app for two days, then reopen.
  now = at(2026, 3, 12, 15, 0);
  const second = new TaskScheduler({ file, now: () => now, host });
  second.start();
  second.stop();
  await second.tick();
  assert.equal(sent, 0, 'stale slots never fire in a burst on launch');
  const task = second.list()[0];
  assert.equal(task.lastStatus, 'missed');
  assert.equal(task.nextRunAt, at(2026, 3, 13, 9, 0));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failing run records the error and still keeps the schedule alive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-task-fail-'));
  let now = at(2026, 3, 10, 8, 59);
  const scheduler = new TaskScheduler({
    file: path.join(dir, 'tasks.json'),
    now: () => now,
    host: { createSession: async () => 'sess', bindSession: () => {}, sendPrompt: async () => { throw new Error('配额不足'); } },
    log: () => {},
  });
  scheduler.create({ prompt: 'run', profileId: 'p1', schedule: { frequency: 'daily', time: '09:00' } });
  now = at(2026, 3, 10, 9, 0);
  await scheduler.tick();
  const [task] = scheduler.list();
  assert.equal(task.lastStatus, 'error');
  assert.equal(task.lastError, '配额不足');
  assert.equal(task.nextRunAt, at(2026, 3, 11, 9, 0));
  fs.rmSync(dir, { recursive: true, force: true });
});
