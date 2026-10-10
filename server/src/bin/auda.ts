/**
 * Process supervisor. Keeps the AUDA core alive:
 *  - restarts it with backoff when it exits unexpectedly;
 *  - restarts it when it stops answering health checks (a hung event loop is
 *    worse than a crash: nothing exits, nothing recovers);
 *  - restarts it gracefully when memory grows past a ceiling;
 *  - after a crash loop, boots it in SAFE MODE (no task execution) so the UI
 *    stays reachable and a poison item can't keep taking everything down.
 * Durable state means every restart resumes rather than resets.
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Set here rather than in the npm script, so `npm start` works in cmd and PowerShell too.
process.env.NODE_ENV ??= 'production';

const entry = path.join(import.meta.dirname, '..', 'index.ts');
const port = Number(process.env.AUDA_PORT ?? 4610);
const dataDir = path.resolve(process.env.AUDA_DATA ?? path.join(import.meta.dirname, '../../../data'));
const maxRssMb = Number(process.env.AUDA_MAX_RSS_MB ?? 2048);
const EXIT_LEAVE_SAFE_MODE = 75;

let child: ReturnType<typeof fork> | null = null;
let stopping = false;
let restarts: number[] = [];
let safeMode = false;
let healthFails = 0;
let lastStart = 0;

const logLine = (m: string) => {
  const line = `${new Date().toISOString()} [supervisor] ${m}`;
  console.error(line);
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(path.join(dataDir, 'supervisor.log'), line + '\n'); } catch { /* best effort */ }
};

function start() {
  lastStart = Date.now();
  healthFails = 0;
  child = fork(entry, { stdio: 'inherit', execArgv: ['--import', 'tsx'], env: { ...process.env, AUDA_SAFE_MODE: safeMode ? '1' : '', AUDA_SUPERVISED: '1', AUDA_RESTARTS: String(restarts.length) } });
  const me = child;
  child.on('exit', (code, signal) => {
    if (me !== child) return;
    child = null;
    if (stopping) return process.exit(0);
    if (code === EXIT_LEAVE_SAFE_MODE) { safeMode = false; restarts = []; logLine('leaving safe mode on request'); return start(); }
    const now = Date.now();
    restarts = [...restarts.filter((t) => now - t < 5 * 60_000), now];
    if (!safeMode && restarts.length >= 5) { safeMode = true; logLine(`core crashed ${restarts.length} times in 5 minutes — next start is in SAFE MODE`); }
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(restarts.length - 1, 5));
    logLine(`core exited (${signal ?? code}); restarting in ${delay / 1000}s`);
    setTimeout(start, delay);
  });
}

// Liveness: an unresponsive core is killed and restarted.
setInterval(async () => {
  if (!child || Date.now() - lastStart < 20_000) return;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
    const j: any = await r.json();
    healthFails = 0;
    if (j.rssMb > maxRssMb) { logLine(`memory ${j.rssMb} MB exceeds ${maxRssMb} MB — graceful restart`); child.kill('SIGTERM'); }
  } catch {
    healthFails++;
    if (healthFails >= 3) { logLine('core stopped answering health checks — killing it'); child.kill('SIGKILL'); }
  }
}, 10_000).unref();

for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => { stopping = true; child ? child.kill(s) : process.exit(0); });
start();
