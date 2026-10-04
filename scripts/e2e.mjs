#!/usr/bin/env node
/**
 * End-to-end vertical slice, against a real AUDA core with a throwaway data dir:
 *
 *   ongoing goal → responsibility → watcher fires → task runs real commands
 *   → approval → resume → verify → artifact + memory → back to WATCHING
 *   → later trigger wakes it again (with procedural memory) → AUDA suggests a rule
 *   → supervisor recovers a hung browser
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4699;
const BASE = `http://localhost:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-e2e-'));
const root = path.resolve(import.meta.dirname, '..');
const core = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: root, env: { ...process.env, AUDA_DATA: data, AUDA_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; core.stdout.on('data', (d) => { logs += d; }); core.stderr.on('data', (d) => { logs += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, body, method) => {
  const r = await fetch(BASE + p, { method: method ?? (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${j.error}`); return j;
};
const state = () => api('/api/bootstrap');
async function until(label, fn, timeout = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const s = await state(); const v = await fn(s); if (v) return v; await sleep(1000); }
  throw new Error(`timed out waiting for: ${label}`);
}
const step = (m) => console.log(`  ✓ ${m}`);
let failed = false;
try {
  for (let i = 0; ; i++) { try { if ((await api('/api/health')).ok) break; } catch { if (i > 40) throw new Error('core did not start'); } await sleep(500); }
  step('AUDA core booted with a fresh data directory');

  // A smaller quota keeps the test quick; the logic is identical.
  const MB = 1048576;
  const { id: resp } = await api('/api/responsibilities', { playbook: 'server.health', title: 'Keep demo-api healthy', config: { service: 'demo-api', path: '~/services/demo-api', quotaBytes: 16 * MB, thresholdPct: 80, rearmPct: 60, intervalSec: 2 } });
  await until('watching', (s) => s.responsibilities.find((r) => r.id === resp && r.state === 'WATCHING' && r.watchers[0].lastValue));
  step('responsibility created and WATCHING');

  async function incident(n) {
    await api('/api/computer/services/demo-api/configure', { key: 'logLevel', value: 'debug' });
    const apr = await until(`approval #${n}`, (s) => s.approvals.find((a) => a.state === 'pending'));
    const task = (await state()).tasks.find((t) => t.id === apr.taskId);
    if (task.state !== 'WAITING_USER') throw new Error('task should wait for the user');
    step(`#${n}: watcher fired → task “${task.title}” ran ${task.currentStep} steps → asks: “${apr.title}”`);
    if (n === 2 && !apr.evidence.some((e) => e.label === 'History')) throw new Error('second incident should cite the earlier approval');
    if (n === 2) step('#2: AUDA cites the earlier decision from memory');
    await api(`/api/approvals/${apr.id}/decide`, { decision: 'approved' });
    const done = await until(`task #${n} completes`, (s) => s.tasks.find((t) => t.id === apr.taskId && t.state === 'COMPLETED'));
    step(`#${n}: approved → resumed → completed: ${done.result}`);
    await until('back to watching', (s) => s.responsibilities.find((r) => r.id === resp && r.state === 'WATCHING'));
    step(`#${n}: responsibility returned to WATCHING`);
    return done;
  }

  const t1 = await incident(1);
  const d1 = await api(`/api/tasks/${t1.id}`);
  if (!d1.artifacts.length) throw new Error('expected an incident report artifact');
  if (!d1.audit.some((a) => a.capability === 'fs.delete' && a.decision.startsWith('approved'))) throw new Error('expected an approved, audited delete');
  step(`artifact ${d1.artifacts[0].path} · audit shows approved fs.delete`);
  const mem = (await state()).memories;
  if (!mem.some((m) => m.kind === 'procedural')) throw new Error('expected procedural memory');
  step('procedural + episodic memory recorded');

  await until('volume drops below re-arm', (s) => s.responsibilities.find((r) => r.id === resp).watchers[0].armed === true, 60_000);
  await incident(2);
  const rule = await until('suggested rule', (s) => s.rules.find((r) => r.state === 'draft' && r.origin?.startsWith('suggested')));
  step(`AUDA suggested a rule: “${rule.text}”`);
  await api(`/api/rules/${rule.id}/activate`, {});

  await until('volume re-armed', (s) => s.responsibilities.find((r) => r.id === resp).watchers[0].armed === true, 60_000);
  const before = (await state()).tasks.length;
  await api('/api/computer/services/demo-api/configure', { key: 'logLevel', value: 'debug' });
  const t3 = await until('third incident handled autonomously', (s) => s.tasks.length > before && s.tasks.find((t) => t.state === 'COMPLETED' && !s.approvals.some((a) => a.taskId === t.id) && t.title.startsWith('Investigate')));
  const d3 = await api(`/api/tasks/${t3.id}`);
  if (!d3.audit.some((a) => a.decision.startsWith('rule:'))) throw new Error('third incident should be authorised by the rule');
  step(`#3: handled without asking, authorised by your rule: ${t3.result}`);

  // Self-recovery: hang the browser and watch the supervisor fix it.
  await api('/api/computer/browser/open', {});
  await api('/api/computer/browser/hang', {});
  await until('browser recovered', (s) => s.activity.find((a) => a.title === 'Recovered the browser automatically'), 40_000);
  step('supervisor detected a hung browser and recovered it automatically');
  console.log('\n  vertical slice: PASS\n');
} catch (e) {
  failed = true;
  console.error(`\n  ✕ ${e.message}${e.cause ? ` (${e.cause.code ?? e.cause})` : ""}\n`, e.stack);
  console.error(logs.split('\n').slice(-30).join('\n'));
} finally {
  try { await api('/api/computer/services/demo-api/stop', {}); } catch { /* already down */ }
  core.kill('SIGTERM');
  await sleep(800);
  fs.rmSync(data, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
