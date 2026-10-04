#!/usr/bin/env node
/**
 * Platform-failure drills against a real AUDA, run under its process supervisor:
 *  1. database corruption → automatic restore from the latest backup
 *  2. a task that keeps taking the core down → quarantined, everything else keeps running
 *  3. a frozen core (SIGSTOP) → watchdog kills and restarts it
 *  4. a crash loop → next boot in safe mode → leave safe mode on request
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4697;
const BASE = `http://localhost:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-e2e-rel-'));
const root = path.resolve(import.meta.dirname, '..');
const env = { ...process.env, AUDA_DATA: data, AUDA_PORT: String(PORT), AUDA_MOCK_MODEL: path.join(root, 'scripts/mock-model.mjs') };
let sup, logs = '';
const startSupervisor = () => { sup = spawn(process.execPath, ['--import', 'tsx', 'server/src/bin/auda.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); sup.stdout.on('data', (d) => { logs += d; }); sup.stderr.on('data', (d) => { logs += d; }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, body) => { const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(4000) }); const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${j.error}`); return j; };
const health = async () => { try { return await api('/api/health'); } catch { return null; } };
async function until(label, fn, timeout = 90_000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { const v = await fn(); if (v) return v; } catch { /* restarting */ } await sleep(500); } throw new Error(`timed out: ${label}`); }
const step = (m) => console.log(`  ✓ ${m}`);
const stopAll = async () => {
  if (!sup || sup.exitCode !== null) return;
  const exited = new Promise((r) => sup.once('exit', r));
  sup.kill('SIGTERM');
  await Promise.race([exited, sleep(15_000)]); // wait for the process tree to exit, not just stop answering
};

let failed = false;
try {
  // 1. Corruption → restore.
  startSupervisor();
  await until('up', health);
  const { id: keep } = await api('/api/tasks', { title: 'Topic Keepsake', goal: 'something to survive' });
  await until('task done', async () => (await api(`/api/tasks/${keep}`)).state === 'COMPLETED');
  await api('/api/system/backup', {});
  await stopAll();
  const dbFile = path.join(data, 'auda.db');
  const fd = fs.openSync(dbFile, 'r+'); fs.writeSync(fd, Buffer.alloc(4096, 0x41), 0, 4096, 4096); fs.writeSync(fd, Buffer.from('garbage-header!!'), 0, 16, 0); fs.closeSync(fd);
  startSupervisor();
  await until('up after corruption', health);
  const sys = await api('/api/system');
  if (sys.boot.integrity !== 'restored') throw new Error(`expected restore, got ${JSON.stringify(sys.boot)}`);
  if ((await api(`/api/tasks/${keep}`)).state !== 'COMPLETED') throw new Error('restored data is missing');
  step(`corrupted database detected at boot and restored from ${sys.boot.restoredFrom}; data intact`);

  // 2. Poison task: crash the core while the same task runs, three times.
  const { id: slow } = await api('/api/tasks', { title: 'Slow job' });
  for (let i = 0; i < 3; i++) {
    await until(`slow job running (${i + 1})`, async () => { const t = await api(`/api/tasks/${slow}`); return t.state === 'RUNNING' && t.steps.some((s) => s.state === 'running'); });
    await sleep(1200);
    const { pid } = await api('/api/health');
    process.kill(pid, 'SIGKILL');
    await sleep(800);
    await until('back up', health);
  }
  const poisoned = await until('quarantine', async () => { const t = await api(`/api/tasks/${slow}`); return t.state === 'FAILED' ? t : null; });
  if (!/quarantin/i.test(poisoned.diagnosis)) throw new Error(`unexpected diagnosis: ${poisoned.diagnosis}`);
  const { id: ok } = await api('/api/tasks', { title: 'Topic Afterwards' });
  await until('other work continues', async () => (await api(`/api/tasks/${ok}`)).state === 'COMPLETED');
  step('a task that crashed the core 3× was quarantined with a diagnosis; other work kept running');

  // 3. Frozen core → watchdog.
  const before = (await api('/api/health')).pid;
  process.kill(before, 'SIGSTOP');
  const after = await until('watchdog restart', async () => { const h = await health(); return h && h.pid !== before ? h : null; }, 90_000);
  step(`frozen core (pid ${before}) was detected by the watchdog and replaced (pid ${after.pid})`);

  // 4. Crash loop → safe mode → leave.
  for (let i = 0; i < 5; i++) {
    const h = await until(`up for crash ${i + 1}`, health, 60_000);
    if (h.safeMode) break;
    process.kill(h.pid, 'SIGKILL');
    await sleep(600);
  }
  const safe = await until('safe mode', async () => { const h = await health(); return h?.safeMode ? h : null; }, 90_000);
  step(`crash loop → AUDA booted in safe mode (pid ${safe.pid}); UI and API stay reachable`);
  await api('/api/system/leave-safe-mode', {});
  await until('normal mode', async () => { const h = await health(); return h && !h.safeMode ? h : null; }, 60_000);
  step('left safe mode on request; normal operation resumed');
  console.log('\n  reliability drills: PASS\n');
} catch (e) {
  failed = true;
  console.error(`\n  ✕ ${e.message}\n`);
  console.error(logs.split('\n').slice(-40).join('\n'));
} finally {
  try { await api('/api/computer/services/demo-api/stop', {}); } catch { /* down */ }
  await stopAll();
  fs.rmSync(data, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
