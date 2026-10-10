#!/usr/bin/env node
/**
 * Smoke test of a fresh install, on any OS: `npm start` boots the supervisor
 * and core, the UI is served, and a command runs on AUDA's computer through the
 * shell AUDA picked (bash, Git Bash or PowerShell). Run after `npm run build`.
 * CI runs it on Linux and Windows.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4799, BASE = `http://127.0.0.1:${PORT}`;
const root = path.resolve(import.meta.dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-smoke-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`  ✓ ${m}`);
const must = (c, m) => { if (!c) throw new Error(m); };
const api = async (p, body) => { const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${j.error}`); return j; };

// Exactly what a user types: `npm start`, through the platform's shell.
const proc = spawn('npm', ['start'], {
  cwd: root, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AUDA_DATA: data, AUDA_PORT: String(PORT), ANTHROPIC_API_KEY: '', AUDA_LMSTUDIO_AUTO: '0', AUDA_DISCOVERY: '0' },
});
let logs = '';
proc.stdout.on('data', (d) => { logs += d; }); proc.stderr.on('data', (d) => { logs += d; });
const stopAll = () => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-proc.pid, 'SIGTERM');
  } catch { /* already gone */ }
};

let failed = false;
try {
  let up = false;
  for (let i = 0; i < 180 && !up; i++) { try { up = (await api('/api/health')).ok; } catch { /* booting */ } if (!up) await sleep(500); }
  must(up, 'AUDA did not start with `npm start`');
  step(`npm start → AUDA is up on ${os.platform()} (Node ${process.versions.node})`);

  const html = await (await fetch(BASE + '/')).text();
  must(/<div id="root">|<script type="module"/.test(html), 'the UI should be served (run `npm run build` first)');
  step('the web UI is served');

  const b = await api('/api/bootstrap');
  const drv = b.computer.driver;
  must(drv.shell && drv.os, `driver info: ${JSON.stringify(drv)}`);
  await api('/api/computer/control', { who: 'human' });
  const r = await api('/api/computer/terminal', { cmd: 'echo auda-smoke-ok' });
  must(r.code === 0 && r.stdout.includes('auda-smoke-ok'), `terminal: ${JSON.stringify(r)}`);
  const fail = await api('/api/computer/terminal', { cmd: 'exit 3' });
  must(fail.code !== 0, 'a failing command reports a non-zero exit code');
  await api('/api/computer/control', { who: 'auda' });
  step(`AUDA's computer runs commands on ${drv.os} through ${drv.shell} (exit codes reported)`);

  console.log('\n  smoke: PASS\n');
} catch (e) {
  failed = true;
  console.error(`\n  ✕ ${e.message}\n`);
  console.error(logs.split('\n').slice(-40).join('\n'));
} finally {
  stopAll();
  await sleep(1500);
  try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* Windows may hold files briefly */ }
  process.exit(failed ? 1 : 0);
}
