#!/usr/bin/env node
/**
 * End-to-end: local models, LAN discovery, pairing, the team chat and uploads.
 *  - LM Studio (a faithful fake on a custom port) is detected, connected with a
 *    real tool-calling probe, and then drives an agent task end to end —
 *    including a quirky model that writes tool calls into text.
 *  - The instance is discoverable by mDNS, UDP broadcast and HTTP.
 *  - A phone pairs with a code; with pairing required, LAN requests without a
 *    token are refused and with the token accepted.
 *  - Team chat: a file is uploaded and handed to a new agent; a running agent
 *    is @mentioned mid-task, reads the message at its next step and answers.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { Bonjour } from 'bonjour-service';
import { startFakeLmStudio } from './fake-lmstudio.mjs';

const PORT = 4696, LM_PORT = 4321, UDP_PORT = 4612;
const BASE = `http://127.0.0.1:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-e2e-lan-'));
const root = path.resolve(import.meta.dirname, '..');
const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
let core, logs = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, body, { token, base = BASE, method } = {}) => {
  const r = await fetch(base + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-auda-token': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(`${p}: ${r.status} ${j.error}`); e.status = r.status; throw e; } return j;
};
async function until(label, fn, timeout = 60_000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(500); } throw new Error(`timed out: ${label}`); }
const step = (m) => console.log(`  ✓ ${m}`);

let failed = false, fake;
try {
  fake = await startFakeLmStudio(LM_PORT);
  core = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: root, env: { ...process.env, AUDA_DATA: data, AUDA_PORT: String(PORT), AUDA_DISCOVERY_PORT: String(UDP_PORT), LMSTUDIO_URL: `http://127.0.0.1:${LM_PORT}`, ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  core.stdout.on('data', (d) => { logs += d; }); core.stderr.on('data', (d) => { logs += d; });
  await until('core up', () => api('/api/health'));

  // ── LM Studio ──
  const det = await until('LM Studio detected', async () => { const d = await api('/api/lmstudio/detect'); return d.found.find((f) => f.baseUrl.includes(String(LM_PORT))) && d; });
  const found = det.found.find((f) => f.baseUrl.includes(String(LM_PORT)));
  if (found.flavor !== 'lmstudio' || found.models.length !== 3) throw new Error('expected LM Studio flavour with 3 models');
  step(`detected LM Studio at ${found.baseUrl}: ${found.models.map((m) => `${m.id} (${m.state})`).join(', ')}`);
  const tiny = await api('/api/lmstudio/connect', { baseUrl: found.baseUrl, model: 'tiny-chat-1b', roles: ['utility'] });
  if (tiny.tools) throw new Error('tiny model should be detected as text-only');
  const conn = await api('/api/lmstudio/connect', { baseUrl: found.baseUrl, model: 'qwen3-coder-30b' });
  if (!conn.tools) throw new Error('expected tool calling to be detected');
  step(`tool-calling probe: tiny-chat-1b → text only; qwen3-coder-30b → tool calling ✓ (${conn.ms} ms)`);
  const { id: wc } = await api('/api/tasks', { title: 'Count words locally', criteria: 'wc.py prints the right count' });
  const t1 = await until('local agent task', async () => { const t = await api(`/api/tasks/${wc}`); return ['COMPLETED', 'FAILED'].includes(t.state) && t; });
  if (t1.state !== 'COMPLETED' || !t1.result.includes('printed 3')) throw new Error(`local task: ${t1.state} ${t1.result ?? t1.diagnosis}`);
  if (t1.verification?.verdict !== 'pass') throw new Error('expected local reviewer to pass');
  step(`agent ran on the local model end to end (malformed JSON + tool call in text recovered): “${t1.result}”`);

  // ── Discovery ──
  const card = await api('/api/discover');
  const udpCard = await new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4'); const t = setTimeout(() => { s.close(); reject(new Error('no UDP reply')); }, 4000);
    s.on('message', (m) => { clearTimeout(t); s.close(); resolve(JSON.parse(String(m))); });
    s.bind(0, () => { s.setBroadcast(true); s.send('AUDA_DISCOVER', UDP_PORT, '127.0.0.1'); });
  });
  if (udpCard.id !== card.id) throw new Error('UDP card mismatch');
  const mdns = await new Promise((resolve) => {
    const b = new Bonjour(); const t = setTimeout(() => { b.destroy(); resolve(null); }, 6000);
    b.find({ type: 'auda' }, (svc) => { if (svc.txt?.id === card.id) { clearTimeout(t); b.destroy(); resolve(svc); } });
  });
  step(`discoverable: HTTP card “${card.name}”, UDP broadcast reply, mDNS _auda._tcp ${mdns ? `on port ${mdns.port}` : 'not visible in this sandbox (multicast blocked)'}`);

  // ── Pairing ──
  const req = await api('/api/pair/request', { name: 'Pixel 9', platform: 'Android 16' });
  const pend = await api('/api/pairings');
  if (!pend.some((p) => p.code === req.code)) throw new Error('pending request should show its code');
  await api(`/api/pair/${req.requestId}/approve`, {});
  const st = await api(`/api/pair/${req.requestId}?secret=${req.secret}`);
  if (st.state !== 'approved' || !st.token) throw new Error('expected a token');
  const again = await api(`/api/pair/${req.requestId}?secret=${req.secret}`);
  if (again.token) throw new Error('token must only be handed out once');
  await api('/api/settings/security.requirePairing', { value: true }, { method: 'PUT' });
  if (lan) {
    const LAN = `http://${lan}:${PORT}`;
    let refused = false; try { await api('/api/bootstrap', undefined, { base: LAN }); } catch (e) { refused = e.status === 401; }
    if (!refused) throw new Error('LAN request without token should be refused');
    await api('/api/bootstrap', undefined, { base: LAN, token: st.token });
    await api('/api/discover', undefined, { base: LAN });
    step(`pairing: code ${req.code} approved → token issued once; with pairing required, ${lan} is refused without it and accepted with it`);
  } else step(`pairing: code ${req.code} approved → token issued once (no LAN interface to test refusal)`);
  await api('/api/settings/security.requirePairing', { value: false }, { method: 'PUT' });

  // ── Team chat: uploads and assignment ──
  const up = await fetch(`${BASE}/api/files?name=${encodeURIComponent('notes.txt')}&dir=${encodeURIComponent('project/docs')}&from=Pixel%209`, { method: 'POST', body: 'The launch is on Friday.\n' }).then((r) => r.json());
  if (!up.path.endsWith('project/docs/notes.txt')) throw new Error(`upload path: ${up.path}`);
  const r1 = await api('/api/group', { text: '/task Summarise the attached file | one sentence', attachments: [up.path] });
  const t2 = await until('attachment task', async () => { const t = await api(`/api/tasks/${r1.taskId}`); return t.state === 'COMPLETED' && t; });
  if (!t2.result.includes('launch is on Friday')) throw new Error(`agent did not read the attachment: ${t2.result}`);
  step(`uploaded ${up.path} (folder kept), assigned it from the team chat → “${t2.result}”`);

  // ── Team chat: @mention a running agent ──
  const r2 = await api('/api/group', { text: '/task Long job with check-ins' });
  await until('long job running', async () => (await api(`/api/tasks/${r2.taskId}`)).state === 'RUNNING');
  await api('/api/group', { text: 'use metric units please', mentions: [r2.taskId] });
  const t3 = await until('long job done', async () => { const t = await api(`/api/tasks/${r2.taskId}`); return t.state === 'COMPLETED' && t; });
  if (!t3.result.includes('metric')) throw new Error(`agent ignored the message: ${t3.result}`);
  const msgs = await api('/api/group/messages');
  const ack = msgs.find((m) => m.authorType === 'agent' && m.authorId === r2.taskId && m.content.includes('Got it'));
  if (!ack) throw new Error('agent did not reply in the team chat');
  const agentsList = await api('/api/agents');
  step(`@mentioned a running agent: it read the message mid-task, replied “${ack.content}”, and finished “${t3.result}”`);
  step(`team chat: ${msgs.length} messages, ${new Set(msgs.filter((m) => m.authorType === 'agent').map((m) => m.authorId)).size} agents posting; ${agentsList.length} addressable (incl. AUDA)`);
  step(`fake LM Studio served ${fake.stats().calls} chat completions`);
  console.log('\n  local models · LAN · team chat: PASS\n');
} catch (e) {
  failed = true;
  console.error(`\n  ✕ ${e.message}\n`);
  console.error(logs.split('\n').slice(-40).join('\n'));
} finally {
  try { await api('/api/computer/services/demo-api/stop', {}); } catch { /* down */ }
  core?.kill('SIGTERM'); fake?.server.close(); await sleep(800);
  fs.rmSync(data, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
