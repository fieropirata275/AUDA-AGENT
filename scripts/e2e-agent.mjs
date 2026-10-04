#!/usr/bin/env node
/**
 * End-to-end test of AUDA's agent path with a scripted model (no API key):
 * real engine, real tools, real computer. Covers review-and-revise, parallel
 * sub-agents, loop detection, approvals inside agents, and a hard crash of
 * the core in the middle of a long command.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4698;
const BASE = `http://localhost:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-e2e-agent-'));
const root = path.resolve(import.meta.dirname, '..');
let core, logs = '';
function boot() {
  core = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: root, env: { ...process.env, AUDA_DATA: data, AUDA_PORT: String(PORT), AUDA_MOCK_MODEL: path.join(root, 'scripts/mock-model.mjs') }, stdio: ['ignore', 'pipe', 'pipe'] });
  core.stdout.on('data', (d) => { logs += d; }); core.stderr.on('data', (d) => { logs += d; });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, body) => { const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${j.error}`); return j; };
async function up() { for (let i = 0; i < 60; i++) { try { if ((await api('/api/health')).ok) return; } catch { /* booting */ } await sleep(500); } throw new Error('core did not start'); }
async function until(label, fn, timeout = 60_000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await sleep(500); } throw new Error(`timed out: ${label}`); }
const task = (id) => api(`/api/tasks/${id}`);
const done = (id, states = ['COMPLETED']) => until(`task ${id} → ${states}`, async () => { const t = await task(id); return states.includes(t.state) ? t : null; });
const step = (m) => console.log(`  ✓ ${m}`);

let failed = false;
try {
  boot(); await up();
  step('core booted with the scripted model');

  // 1. Real coding task + independent review that rejects the first answer.
  const { id: wc } = await api('/api/tasks', { title: 'Build a word counter', goal: 'A python script that counts words on stdin', criteria: 'Running it on real input prints the right count' });
  const t1 = await done(wc);
  if (!t1.result.includes('VERIFIED') || !t1.result.includes('3')) throw new Error(`unexpected result: ${t1.result}`);
  if (t1.verification?.verdict !== 'pass' || t1.verification.round !== 2) throw new Error('expected review to fail once, then pass');
  if (!t1.plan.every((s) => s.status === 'done')) throw new Error('plan should be complete');
  step(`coding task: wrote and ran wc.py; reviewer rejected round 1, passed round 2 → “${t1.result}”`);

  // 2. Orchestration: parent spawns 3 sub-agents in parallel and joins their results.
  const { id: par } = await api('/api/tasks', { title: 'Research three topics', criteria: 'One note per topic' });
  const t2 = await done(par);
  if (t2.children.length !== 3 || !t2.children.every((c) => c.state === 'COMPLETED')) throw new Error('expected 3 completed children');
  if (!t2.result.includes('All three subtasks reported back')) throw new Error(`parent did not receive child results: ${t2.result}`);
  step('orchestration: 3 parallel sub-agents finished and the parent combined their results');

  // 3. Loop detection stops a stuck agent with a diagnosis instead of burning budget.
  const { id: lp } = await api('/api/tasks', { title: 'Loop forever' });
  const t3 = await done(lp, ['FAILED']);
  if (!/loop/i.test(t3.diagnosis ?? '')) throw new Error('expected a loop diagnosis');
  step(`loop detection: stopped after repeated identical calls → “${t3.diagnosis.slice(0, 90)}…”`);

  // 4. A destructive command inside an agent pauses for approval, then continues.
  const { id: cl } = await api('/api/tasks', { title: 'Clean the scratch folder' });
  const apr = await until('approval', async () => (await api('/api/bootstrap')).approvals.find((a) => a.taskId === cl && a.state === 'pending'));
  await api(`/api/approvals/${apr.id}/decide`, { decision: 'approved' });
  await done(cl);
  step(`approval inside an agent: “${apr.title}” → approved → completed`);

  // 5. Hard crash of the whole core in the middle of a long command; AUDA resumes.
  const { id: sl } = await api('/api/tasks', { title: 'Slow job' });
  await until('slow job running', async () => (await task(sl)).state === 'RUNNING' && (await task(sl)).steps.some((s) => s.state === 'running'));
  await sleep(2000);
  core.kill('SIGKILL'); await sleep(500);
  boot(); await up();
  const t5 = await done(sl);
  if (!t5.result.includes('slow-done')) throw new Error(`unexpected: ${t5.result}`);
  const d5 = await task(sl);
  if (!d5.activity.some((a) => a.kind === 'recover')) throw new Error('expected a recovery record');
  step('crash recovery: core SIGKILLed mid-command; restarted, recovered the task and finished it');

  const sys = await api('/api/system');
  step(`system: integrity ${sys.boot.integrity}, ${sys.bus.replayed} events replayed, ${sys.pendingEvents} pending`);
  console.log('\n  agent path: PASS\n');
} catch (e) {
  failed = true;
  console.error(`\n  ✕ ${e.message}\n`);
  console.error(logs.split('\n').slice(-40).join('\n'));
} finally {
  try { await api('/api/computer/services/demo-api/stop', {}); } catch { /* down */ }
  core?.kill('SIGTERM'); await sleep(800);
  fs.rmSync(data, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
