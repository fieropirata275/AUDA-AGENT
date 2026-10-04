// Runs the AUDA core (with reload) and the Vite UI together.
import { spawn } from 'node:child_process';
const procs = [
  spawn('npm', ['run', 'dev:server'], { stdio: 'inherit', shell: true }),
  spawn('npm', ['run', 'dev:web'], { stdio: 'inherit', shell: true }),
];
const stop = () => { for (const p of procs) p.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (c) => { if (c) stop(); });
console.log('\n  AUDA UI  → http://localhost:5173\n  AUDA API → http://localhost:4610\n');
