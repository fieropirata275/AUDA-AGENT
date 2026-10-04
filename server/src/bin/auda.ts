/**
 * Process supervisor. Keeps the AUDA core alive: restarts it with backoff if
 * it exits unexpectedly. Durable state means a restart resumes, not resets.
 */
import { fork } from 'node:child_process';
import path from 'node:path';

const entry = path.join(import.meta.dirname, '..', 'index.ts');
let restarts = 0;
let lastStart = 0;
let child: ReturnType<typeof fork> | null = null;
let stopping = false;

function start() {
  lastStart = Date.now();
  child = fork(entry, { stdio: 'inherit', execArgv: ['--import', 'tsx'] });
  child.on('exit', (code, signal) => {
    if (stopping) return process.exit(0);
    if (Date.now() - lastStart > 60_000) restarts = 0;
    const delay = Math.min(30_000, 1000 * 2 ** restarts++);
    console.error(`[auda] core exited (${signal ?? code}); restarting in ${delay / 1000}s`);
    setTimeout(start, delay);
  });
}
for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => { stopping = true; child?.kill(s); });
start();
