#!/usr/bin/env node
/**
 * A stand-in for LM Studio's `lms` CLI, for e2e-lmstudio.mjs. `server start`
 * launches the fake LM Studio server (fake-lmstudio.mjs) as its own process,
 * like the real CLI waking the LM Studio service; every call is appended to
 * FAKE_LMS_LOG so the test can see what AUDA asked for.
 *   env: FAKE_LMS_LOG, FAKE_LM_STATE (model list file), FAKE_LM_OPTS (JSON options)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (process.env.FAKE_LMS_LOG) fs.appendFileSync(process.env.FAKE_LMS_LOG, `${args.join(' ')}\n`);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };

if (args[0] === 'daemon' && args[1] === 'up') { console.log(JSON.stringify({ status: 'running', pid: process.pid, isDaemon: true, version: '0.4.4+1' })); process.exit(0); }
if (args[0] === 'server' && args[1] === 'start') {
  const port = Number(flag('--port', '1234'));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fake-lmstudio-server.mjs'), String(port)], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/models`)).ok) { console.log(`Success! Server is now running on port ${port}`); process.exit(0); } } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error('Server did not start'); process.exit(1);
}
if (args[0] === 'server' && args[1] === 'status') { console.log(JSON.stringify({ running: false })); process.exit(0); }
console.error(`fake lms: unsupported command ${args.join(' ')}`);
process.exit(1);
