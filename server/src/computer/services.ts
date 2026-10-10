/**
 * Services running on AUDA's computer. Ships with one: `demo-api`, a small
 * service that writes logs and rotates them. It exists so AUDA has a real
 * server to keep healthy out of the box (the vertical slice), without touching
 * anything on your own machines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../core/config.ts';
import { sanitizedEnv } from './driver.ts';
import { publish } from '../core/streams.ts';

const DEMO_DIR = path.join(config.workspaceDir, 'services', 'demo-api');

const DEMO_SCRIPT = `// demo-api — a tiny service living on AUDA's computer.
// Writes request logs; rotates app.log at 4 MB into app.log.1, app.log.2, …
const fs = require('fs'), path = require('path');
const dir = __dirname, logs = path.join(dir, 'logs');
fs.mkdirSync(logs, { recursive: true });
const ROTATE_AT = 4 * 1024 * 1024;
let cfg = { logLevel: 'info' };
const readCfg = () => { try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); } catch {} };
readCfg(); setInterval(readCfg, 1000);
const routes = ['/v1/orders', '/v1/quotes', '/v1/suppliers', '/v1/health', '/v1/parts/search'];
function rotate() {
  const files = fs.readdirSync(logs).filter((f) => /^app\\.log\\.\\d+$/.test(f)).map((f) => +f.split('.').pop()).sort((a, b) => b - a);
  for (const n of files.filter((n) => n >= 40)) fs.rmSync(path.join(logs, 'app.log.' + n)); // hard safety cap
  for (const n of files.filter((n) => n < 40)) fs.renameSync(path.join(logs, 'app.log.' + n), path.join(logs, 'app.log.' + (n + 1)));
  fs.renameSync(path.join(logs, 'app.log'), path.join(logs, 'app.log.1'));
}
function line(level) {
  const r = routes[Math.floor(Math.random() * routes.length)];
  const ms = Math.floor(5 + Math.random() * 80);
  if (level === 'debug') return new Date().toISOString() + ' DEBUG pool.acquire conn=' + Math.floor(Math.random() * 64) + ' route=' + r + ' payload=' + 'x'.repeat(380) + '\\n';
  return new Date().toISOString() + ' INFO ' + r + ' 200 ' + ms + 'ms\\n';
}
setInterval(() => {
  const f = path.join(logs, 'app.log');
  const n = cfg.logLevel === 'debug' ? 100 : 2;
  let chunk = '';
  for (let i = 0; i < n; i++) chunk += line(cfg.logLevel === 'debug' ? 'debug' : 'info');
  fs.appendFileSync(f, chunk);
  try { if (fs.statSync(f).size > ROTATE_AT) rotate(); } catch {}
}, 100);
fs.writeFileSync(path.join(dir, 'demo-api.pid'), String(process.pid));
`;

export interface ServiceStatus { name: string; running: boolean; pid?: number; logLevel?: string; path: string }

export function installDemo() {
  fs.mkdirSync(path.join(DEMO_DIR, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(DEMO_DIR, 'server.js'), DEMO_SCRIPT);
  if (!fs.existsSync(path.join(DEMO_DIR, 'config.json'))) fs.writeFileSync(path.join(DEMO_DIR, 'config.json'), JSON.stringify({ logLevel: 'info' }, null, 2));
  fs.writeFileSync(path.join(DEMO_DIR, 'README.md'),
    '# demo-api\n\nA small service on AUDA\'s computer. AUDA keeps it healthy.\n\n* Logs: `logs/app.log` (rotated at 4 MB)\n* Config: `config.json` — `logLevel` is `info` or `debug`\n* Volume quota: 48 MB\n');
}

function pidOf(name: string) {
  try { return Number(fs.readFileSync(path.join(config.workspaceDir, 'services', name, `${name}.pid`), 'utf8')); } catch { return undefined; }
}
function alive(pid?: number) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

export function status(name = 'demo-api'): ServiceStatus {
  const pid = pidOf(name);
  let logLevel: string | undefined;
  try { logLevel = JSON.parse(fs.readFileSync(path.join(config.workspaceDir, 'services', name, 'config.json'), 'utf8')).logLevel; } catch { /* none */ }
  return { name, running: alive(pid), pid: alive(pid) ? pid : undefined, logLevel, path: `~/services/${name}` };
}

export function start(name = 'demo-api') {
  if (status(name).running) return status(name);
  const dir = path.join(config.workspaceDir, 'services', name);
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true, env: sanitizedEnv() });
  child.unref();
  fs.writeFileSync(path.join(dir, `${name}.pid`), String(child.pid));
  publish('services', status(name));
  return status(name);
}

export async function stop(name = 'demo-api') {
  const pid = pidOf(name);
  if (alive(pid)) { try { process.kill(pid!, 'SIGTERM'); } catch { /* gone */ } }
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  publish('services', status(name));
}

export async function restart(name = 'demo-api') { await stop(name); return start(name); }

export function configure(name: string, key: string, value: string) {
  const f = path.join(config.workspaceDir, 'services', name, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  const before = cfg[key];
  cfg[key] = value;
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
  publish('services', status(name));
  return { key, before, after: value };
}

export const list = () => fs.existsSync(path.join(config.workspaceDir, 'services'))
  ? fs.readdirSync(path.join(config.workspaceDir, 'services')).map((n) => status(n)) : [];
