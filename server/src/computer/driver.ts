/**
 * Computer drivers. AUDA's computer is a persistent environment; the driver
 * decides where commands actually run:
 *   local  — a sandboxed workspace directory on the AUDA host (development)
 *   docker — a long-lived container (`auda-computer`) sharing the workspace volume
 *   ssh    — a dedicated VM (e.g. a Proxmox guest) reached over SSH
 * The workspace volume is shared with the core so file tools work for all drivers.
 */
import { spawn } from 'node:child_process';
import { config } from '../core/config.ts';

export interface ExecResult { code: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean }

const SAFE_ENV_KEYS = ['PATH', 'LANG', 'TERM', 'TZ', 'USER', 'SHELL'];
function sanitizedEnv(): NodeJS.ProcessEnv {
  // Credentials never enter AUDA's computer through the environment.
  const env: NodeJS.ProcessEnv = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k];
  env.HOME = config.workspaceDir;
  env.TERM = 'xterm-256color';
  env.AUDA_COMPUTER = '1';
  return env;
}

function argv(cmd: string, cwd: string): [string, string[]] {
  switch (config.computerDriver) {
    case 'docker':
      return ['docker', ['exec', '-w', cwd.replace(config.workspaceDir, '/home/auda'), process.env.AUDA_COMPUTER_CONTAINER ?? 'auda-computer', 'bash', '-lc', cmd]];
    case 'ssh':
      return ['ssh', ['-o', 'BatchMode=yes', process.env.AUDA_COMPUTER_SSH ?? 'auda@auda-computer', `cd ${JSON.stringify(cwd.replace(config.workspaceDir, '~'))} && ${cmd}`]];
    default:
      return ['bash', ['-lc', cmd]];
  }
}

export function exec(cmd: string, opts: { cwd?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<ExecResult> {
  const cwd = opts.cwd ?? config.workspaceDir;
  const max = opts.maxBytes ?? 64_000;
  const started = Date.now();
  return new Promise((resolve) => {
    const [bin, args] = argv(cmd, cwd);
    const child = spawn(bin, args, { cwd: config.computerDriver === 'local' ? cwd : undefined, env: sanitizedEnv() });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs ?? 30_000);
    child.stdout.on('data', (d) => { if (stdout.length < max) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < max) stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.slice(0, max), stderr: stderr.slice(0, max), durationMs: Date.now() - started, timedOut });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e), durationMs: Date.now() - started, timedOut }); });
  });
}

export const driverInfo = () => ({
  driver: config.computerDriver,
  label: { local: 'Local workspace', docker: 'Docker container', ssh: 'Dedicated VM (SSH)' }[config.computerDriver],
  home: config.workspaceDir,
});
