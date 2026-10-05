#!/usr/bin/env node
/**
 * End-to-end: zero-touch LM Studio. A fresh AUDA with nothing configured…
 *  A. finds LM Studio installed (a fake `lms` CLI), starts its server on its
 *     own, sees no model that can run agents and suggests a download sized for
 *     this machine; one click downloads it (with progress), loads it with a
 *     real context (falling back when memory is short), probes tool calling,
 *     measures speed, connects every role and picks up the embedding model.
 *  B. heals: an evicted model is reloaded, a too-small context is enlarged,
 *     and a crashed server is restarted — each time the task still completes.
 *  C. with no LM Studio anywhere, setup explains what to install; when a
 *     server with a ready model appears, AUDA connects to it by itself.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeLmStudio } from './fake-lmstudio.mjs';

const root = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`  ✓ ${m}`);
const must = (c, m) => { if (!c) throw new Error(m); };
async function until(label, fn, timeout = 60_000) { const t0 = Date.now(); let last; while (Date.now() - t0 < timeout) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(300); } throw new Error(`timed out: ${label}${last ? ` (${last.message})` : ''}`); }

const cores = [];
function boot(port, env) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-e2e-lms-'));
  const core = { logs: '', data, base: `http://127.0.0.1:${port}` };
  core.proc = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: root, env: { ...process.env, AUDA_DATA: data, AUDA_PORT: String(port), ANTHROPIC_API_KEY: '', AUDA_MOCK_MODEL: '', AUDA_LMSTUDIO_POLL_MS: '1500', AUDA_LMS_POLL_MS: '100', AUDA_DISCOVERY: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  core.proc.stdout.on('data', (d) => { core.logs += d; }); core.proc.stderr.on('data', (d) => { core.logs += d; });
  core.api = async (p, body, method) => { const r = await fetch(core.base + p, { method: method ?? (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p}: ${r.status} ${j.error}`); return j; };
  core.boot = () => core.api('/api/bootstrap');
  core.setup = async () => (await core.boot()).settings.models.localSetup;
  cores.push(core);
  return core;
}
const fakeApi = async (port, p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();

let failed = false;
const LM = 4331, LM2 = 4332;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-e2e-lms-fake-'));
const lmsLog = path.join(work, 'lms.log');
try {
  // ── A. zero-touch: installed but not running, no suitable model ───────────
  const a = boot(4697, {
    LMSTUDIO_URL: `http://127.0.0.1:${LM}`, AUDA_LMS_BIN: path.join(root, 'scripts/fake-lms.mjs'), AUDA_FAKE_GPU: 'Test GPU:24',
    FAKE_LMS_LOG: lmsLog, FAKE_LM_STATE: path.join(work, 'models.json'),
    FAKE_LM_OPTS: JSON.stringify({ jit: false, maxLoadContext: 16384, models: [
      { key: 'tiny-chat-1b', type: 'llm', size: 0.8e9, params: '1B', tools: false, max: 4096, loaded: 0 },
      { key: 'text-embedding-nomic-embed-text-v1.5', type: 'embedding', size: 0.08e9, max: 2048, loaded: 0 },
    ] }),
  });
  await until('core up', () => a.api('/api/health'));
  const first = await until('first-run setup to finish', async () => { const s = await a.setup(); return s && !s.running && s.outcome && s; });
  must(first.outcome === 'needs-model', `expected needs-model, got ${first.outcome}: ${first.message}`);
  must(fs.readFileSync(lmsLog, 'utf8').includes(`server start --port ${LM}`), 'AUDA should have started the server with lms');
  const rec = first.suggestions?.[0];
  must(rec?.recommended && rec.key, 'a recommended download');
  must(first.hardware?.gpus?.[0]?.vramGb === 24, 'hardware detected');
  let b = await a.boot();
  must(b.notifications.some((n) => /needs one model/.test(n.title)), 'a notification should say one model is needed');
  must(b.activity.some((x) => /Started LM Studio’s server/.test(x.title)), 'starting the server is logged');
  step(`first run: AUDA started LM Studio itself (lms server start --port ${LM}), found no tool-calling model, and recommends ${rec.name} (${rec.gb} GB) for “${first.hardware.summary}”`);

  const doctor = await a.api('/api/lmstudio/doctor');
  must(doctor.api === 'v1' && doctor.ranked.length === 1 && doctor.ranked[0].tools === 'no', `doctor: ${JSON.stringify(doctor.ranked)}`);
  await a.api('/api/lmstudio/setup', { download: rec.key });
  let sawProgress = 0;
  const done = await until('one-click setup', async () => { const s = await a.setup(); if (s?.download && s.download.pct > 0 && s.download.pct < 100) sawProgress++; return s && !s.running && s.outcome && s; }, 90_000);
  must(done.outcome === 'connected', `setup: ${done.outcome} — ${done.message} ${JSON.stringify(done.steps)}`);
  must(done.steps.every((x) => x.state === 'done'), `every step done: ${JSON.stringify(done.steps.map((x) => [x.id, x.state, x.detail]))}`);
  must(done.result.model === rec.key && done.result.tools && done.result.context === 16384 && done.result.tps > 0, `result: ${JSON.stringify(done.result)}`);
  must(done.result.embeddings === 'text-embedding-nomic-embed-text-v1.5', 'the embedding model is used for knowledge');
  const fs1 = await fakeApi(LM, '/__state');
  must(fs1.loads.some((l) => l.model === rec.key && l.context === 16384), `loaded with fallback context: ${JSON.stringify(fs1.loads)}`);
  b = await a.boot();
  must(b.settings.models.roles.reasoning.provider === 'local' && b.settings.models.roles.reasoning.model === rec.key, 'reasoning runs on the local model');
  must(b.settings.models.local.manage && b.settings.models.local.desiredContext === 16384, 'managed, with its context remembered');
  step(`one click: downloaded ${rec.key} (progress seen ${sawProgress}×), loaded it (32k didn’t fit → 16k), tool calling ✓, ~${done.result.tps} tok/s, every role connected, embeddings on`);

  // ── B. healing ────────────────────────────────────────────────────────────
  const runTask = async (title) => {
    const { id } = await a.api('/api/tasks', { title: 'Count words locally', criteria: 'wc.py prints the right count', goal: title });
    const t = await until(`task ${title}`, async () => { const x = await a.api(`/api/tasks/${id}`); return ['COMPLETED', 'FAILED'].includes(x.state) && x; }, 90_000);
    must(t.state === 'COMPLETED', `${title}: ${t.state} ${t.diagnosis ?? t.error ?? ''}\n${a.logs.split('\n').slice(-20).join('\n')}`);
    return t;
  };
  await fakeApi(LM, '/__evict', {});
  await runTask('after eviction');
  b = await a.boot();
  must(b.activity.some((x) => x.title === `Loaded ${rec.key}`), 'eviction healed by a reload');
  step('evicted model (LM Studio unloaded it, JIT off): AUDA reloaded it with its context and the task completed');

  await fakeApi(LM, '/__shrink', { context: 256 });
  await runTask('after shrink');
  b = await a.boot();
  must(b.activity.some((x) => /Gave .* a larger context/.test(x.title)), `context overflow healed: ${b.activity.slice(0, 12).map((x) => x.title).join(' | ')} · loads ${JSON.stringify((await fakeApi(LM, '/__state')).loads)}`);
  step('context overflow (model loaded with a 256-token window): AUDA reloaded it with a larger window and retried');

  await fakeApi(LM, '/__close', {});
  await sleep(300);
  await runTask('after crash');
  b = await a.boot();
  must(b.activity.some((x) => /Restarted LM Studio’s server/.test(x.title)), 'server restart logged');
  must((fs.readFileSync(lmsLog, 'utf8').match(/server start/g) ?? []).length >= 2, 'restarted with lms');
  step('server crash: AUDA restarted LM Studio with lms, reloaded the model and the task completed');

  // ── C. nothing installed → guidance; a server appears → automatic connect ──
  const c = boot(4698, { LMSTUDIO_URL: `http://127.0.0.1:${LM2}`, AUDA_LMS_BIN: path.join(work, 'no-lms-here'), AUDA_FAKE_GPU: '' });
  await until('core C up', () => c.api('/api/health'));
  await c.api('/api/lmstudio/setup', {});
  const none = await until('setup without LM Studio', async () => { const s = await c.setup(); return s && !s.running && s.outcome && s; });
  must(none.outcome === 'no-server' && none.suggestions?.length, `no-server: ${JSON.stringify(none)}`);
  step(`no LM Studio anywhere: setup says what to install and which model suits this machine (${none.suggestions[0].name})`);
  const fake2 = await startFakeLmStudio(LM2);
  const auto = await until('automatic connect', async () => { const s = (await c.boot()).settings.models; return s.local?.model && s.roles.reasoning.provider === 'local' && s; }, 30_000);
  const nb = await c.boot();
  must(nb.notifications.some((n) => /AUDA is running on qwen3-coder-30b/.test(n.title)), `notification: ${nb.notifications.map((n) => n.title).join(' | ')}`);
  must(auto.local.model === 'qwen3-coder-30b' && auto.local.tools, `auto-connected: ${JSON.stringify(auto.local)}`);
  fake2.server.close();
  step('a server with a ready model appeared: AUDA connected to it on its own (qwen3-coder-30b, tool calling ✓) and said so');

  console.log('\n  zero-touch LM Studio (start, choose, download, load, probe, heal, auto-connect): PASS\n');
} catch (e) {
  failed = true;
  console.error(`\n  ✕ ${e.message}\n`);
  for (const c of cores) console.error(c.logs.split('\n').slice(-25).join('\n'));
} finally {
  for (const c of cores) c.proc.kill('SIGTERM');
  await fetch(`http://127.0.0.1:${LM}/__close`, { method: 'POST' }).catch(() => undefined);
  await sleep(500);
  for (const c of cores) fs.rmSync(c.data, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
