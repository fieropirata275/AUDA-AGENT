#!/usr/bin/env node
/**
 * auda-link — connect one of YOUR machines to AUDA.
 *
 *   node scripts/auda-link.mjs --server ws://auda.local:4610 --token <pairing token>
 *
 * The device connects outbound. AUDA can only use capabilities you grant in
 * Connections → Your devices, and this client enforces the same grants
 * locally. Pass --allow terminal to permit terminal jobs from this side too;
 * without it, every job is refused here regardless of what the server says.
 */
import os from 'node:os';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const server = arg('server', 'ws://localhost:4610');
const token = arg('token');
const localAllow = new Set((arg('allow', '') || '').split(',').filter(Boolean));
if (!token) { console.error('Usage: auda-link --server ws://host:4610 --token <token> [--allow terminal]'); process.exit(1); }

let grants = {};
function connect() {
  const ws = new WebSocket(`${server.replace(/\/$/, '')}/link?token=${encodeURIComponent(token)}`);
  ws.on('open', () => {
    console.log(`linked to ${server} as ${os.hostname()}`);
    ws.send(JSON.stringify({ type: 'hello', platform: `${os.platform()} ${os.release()}`, host: os.hostname() }));
    setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })), 20_000);
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'grants') { grants = m.grants; console.log('grants:', Object.entries(grants).map(([k, v]) => `${v ? '✓' : '✗'} ${k}`).join('  ')); }
    if (m.type === 'exec') {
      if (!grants.terminal || !localAllow.has('terminal')) {
        ws.send(JSON.stringify({ type: 'result', id: m.id, error: 'Terminal access is not allowed on this device' }));
        return;
      }
      console.log(`AUDA runs: ${m.cmd}`);
      const p = spawn(process.platform === 'win32' ? 'cmd' : 'bash', process.platform === 'win32' ? ['/c', m.cmd] : ['-lc', m.cmd]);
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
      const t = setTimeout(() => p.kill('SIGKILL'), 55_000);
      p.on('close', (code) => { clearTimeout(t); ws.send(JSON.stringify({ type: 'result', id: m.id, code, stdout: stdout.slice(0, 64_000), stderr: stderr.slice(0, 16_000) })); });
    }
  });
  ws.on('close', (code, reason) => {
    if (code === 4001 || code === 4003) { console.log(`AUDA closed the link: ${reason || code}`); process.exit(0); }
    console.log('disconnected; retrying in 3s'); setTimeout(connect, 3000);
  });
  ws.on('error', () => {});
}
connect();
