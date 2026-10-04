/**
 * Unit tests for AUDA's deterministic core: scheduling, policy, rule
 * compilation, command classification and the broker's idempotency.
 * Run with: npm test (uses an isolated temporary data directory).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-test-'));
process.env.AUDA_DATA = dir;

const { nextCron } = await import('../src/scheduler/cron.ts');
const { parseSchedule } = await import('../src/scheduler/fuzzy.ts');
const { classifyCommand } = await import('../src/policy/capabilities.ts');
const { compileBuiltin, createRule, activateRule } = await import('../src/policy/rules.ts');
const { decide } = await import('../src/policy/engine.ts');
const { registerTool, call } = await import('../src/tools/broker.ts');
const { NeedsApproval, PolicyDenied } = await import('../src/tools/errors.ts');
const { insert, now, q } = await import('../src/core/db.ts');
const { remember, recall } = await import('../src/memory/service.ts');

test('cron: next weekday 09:00', () => {
  const mon = new Date(2026, 9, 5, 10, 0).getTime(); // Monday 10:00
  const next = new Date(nextCron('0 9 * * 1-5', mon));
  assert.equal(next.getDay(), 2);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
});

test('cron: every 15 minutes', () => {
  const t = new Date(2026, 0, 1, 12, 7).getTime();
  assert.equal(new Date(nextCron('*/15 * * * *', t)).getMinutes(), 15);
});

test('fuzzy schedules', () => {
  const base = new Date(2026, 9, 4, 20, 0).getTime(); // Sunday evening
  const a = parseSchedule('tomorrow at 9', base)!;
  assert.equal(a.kind, 'once');
  assert.equal(new Date(a.nextRunAt).getHours(), 9);
  const b = parseSchedule('every Monday morning', base)!;
  assert.equal(b.kind, 'cron');
  assert.equal(new Date(b.nextRunAt).getDay(), 1);
  const c = parseSchedule('in 10 minutes', base)!;
  assert.equal(c.nextRunAt - base, 600_000);
  const d = parseSchedule('tomorrow morning', base)!;
  assert.equal(d.kind, 'fuzzy');
  const h = new Date(d.nextRunAt).getHours();
  assert.ok(h >= 8 && h < 10, `picked ${h}`);
  assert.equal(parseSchedule('every 2 hours', base)!.spec, '7200');
});

test('command classification is conservative', () => {
  assert.equal(classifyCommand('du -sh services'), 'terminal.read');
  assert.equal(classifyCommand('tail -n 20 logs/app.log 2>&1'), 'terminal.read');
  assert.equal(classifyCommand('ls > /dev/null'), 'terminal.read');
  assert.equal(classifyCommand('gzip logs/app.log.3'), 'terminal.write');
  assert.equal(classifyCommand('echo hi >> notes.txt'), 'terminal.write');
  assert.equal(classifyCommand('rm -rf logs'), 'terminal.destructive');
  assert.equal(classifyCommand('find . -name "*.log" -delete'), 'terminal.destructive');
  assert.equal(classifyCommand(': > logs/app.log'), 'terminal.destructive');
  assert.equal(classifyCommand('sudo systemctl restart x'), 'terminal.destructive');
});

test('rule compiler: the examples from the brief', () => {
  assert.deepEqual(compileBuiltin('Never spend money.')!.compiled.effect, 'deny');
  assert.ok(compileBuiltin('Never spend money.')!.compiled.capabilities.includes('money.spend'));
  const email = compileBuiltin("Don't ever send emails from this account without asking me.")!.compiled;
  assert.equal(email.effect, 'ask');
  assert.ok(email.capabilities.includes('email.send'));
  const night = compileBuiltin('Never contact clients after 20:00.')!.compiled;
  assert.equal(night.effect, 'deny');
  assert.equal(night.hours?.from, 20);
  const del = compileBuiltin('Always ask before deleting files outside /tmp.')!.compiled;
  assert.equal(del.effect, 'ask');
  assert.equal(del.resourceNot, '/tmp*');
  const rev = compileBuiltin('When you can safely fix something reversible on my development server, do it without asking.')!.compiled;
  assert.equal(rev.effect, 'allow');
  assert.ok(rev.capabilities.includes('risk:reversible'));
  const quiet = compileBuiltin("Don't wake me for low-priority completed jobs")!.compiled;
  assert.equal(quiet.effect, 'quiet');
  assert.deepEqual(quiet.levels, ['completed', 'fyi']);
  const budget = compileBuiltin('AUDA can spend up to €5 in API credits per day')!.compiled;
  assert.equal(budget.effect, 'budget');
  assert.equal(budget.dailyBudget, 5);
  assert.equal(compileBuiltin('the weather is nice'), null);
});

test('policy: defaults, rules and specificity', () => {
  assert.equal(decide('fs.read', { path: '~/x' }).verdict, 'allow');
  assert.equal(decide('fs.delete', { dir: '~/services/demo-api', paths: ['a'] }).verdict, 'ask');
  const deny = createRule('Never spend money', { ...compileBuiltin('Never spend money')!, state: 'active' });
  assert.equal(decide('money.spend', { amount: 3 }).verdict, 'deny');
  const allow = createRule('AUDA may clean up demo-api logs', { compiled: { effect: 'allow', capabilities: ['fs.delete'], resource: '*demo-api*' }, interpretation: 'x' });
  assert.equal(decide('fs.delete', { dir: '~/services/demo-api', paths: ['a'] }).verdict, 'ask', 'draft rules have no effect');
  activateRule(allow);
  assert.equal(decide('fs.delete', { dir: '~/services/demo-api', paths: ['a'] }).verdict, 'allow');
  assert.equal(decide('fs.delete', { dir: '~/elsewhere', paths: ['a'] }).verdict, 'ask', 'resource scoping holds');
  void deny;
});

test('broker: approvals and idempotency', async () => {
  let runs = 0;
  registerTool('github.comment', async () => { runs++; return { externalId: 'c1' }; });
  const taskId = 'task_test';
  insert('tasks', { id: taskId, title: 't', playbook: 'agent', state: 'RUNNING', created_at: now(), updated_at: now() });
  const input = { repo: 'a/b', number: 1, body: 'hi' };
  await assert.rejects(call('github.comment', input, { taskId, stepIdx: 0 }), NeedsApproval);
  const apr = q.get('SELECT id FROM approvals WHERE task_id = ?', taskId)!;
  q.run("UPDATE approvals SET state = 'approved' WHERE id = ?", apr.id);
  await call('github.comment', input, { taskId, stepIdx: 0 });
  await call('github.comment', input, { taskId, stepIdx: 0 });
  assert.equal(runs, 1, 'a retry must not perform the external action twice');
  const audit = q.all('SELECT result FROM audit_log WHERE task_id = ? ORDER BY ts', taskId).map((r) => r.result);
  assert.deepEqual(audit, ['ok', 'deduplicated']);
  await assert.rejects(call('github.comment', input, {}), PolicyDenied, 'approval-level actions need a task');
});

test('memory: reinforcement upgrades weight instead of duplicating', () => {
  const a = remember({ kind: 'preference', title: 'Short updates', content: 'Prefers short updates', source: 'chat' });
  remember({ kind: 'preference', title: 'short updates', content: 'Prefers short, direct updates', source: 'chat' });
  const b = remember({ kind: 'preference', title: 'Short updates', content: 'Prefers short, direct updates', source: 'chat' });
  assert.equal(a, b);
  const m = q.get('SELECT * FROM memories WHERE id = ?', a)!;
  assert.equal(m.reinforced, 3);
  assert.equal(m.weight, 'established');
  assert.equal(recall('direct updates')[0].id, a);
});

test('chat: reminders extract the thing to remember, not the time', async () => {
  await import('../src/playbooks/routines.ts');
  const { compileIntent } = await import('../src/agent/intents.ts');
  const r1 = await compileIntent('remind me tomorrow at 9 to call the supplier', {});
  assert.equal(q.get('SELECT title FROM tasks WHERE id = ?', r1.objects[0].id)!.title, 'Remind you to call the supplier');
  const r2 = await compileIntent('Remind me to water the plants every Monday morning', {});
  assert.equal(q.get('SELECT title FROM responsibilities WHERE id = ?', r2.objects[0].id)!.title, 'Remind you to water the plants');
});
