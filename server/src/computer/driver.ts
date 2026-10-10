/**
 * Computer drivers. AUDA's computer is a persistent environment; the driver
 * decides where commands actually run:
 *   local  — a sandboxed workspace directory on the AUDA host (development)
 *   docker — a long-lived container (`auda-computer`) sharing the workspace volume
 *   ssh    — a dedicated VM (e.g. a Proxmox guest) reached over SSH
 * The workspace volume is shared with the core so file tools work for all drivers.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config.ts';

export interface ExecResult { code: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean }

/** Which shell runs commands on AUDA's computer, and on what OS — agents are told, so they write commands that work. */
export interface ShellInfo { kind: 'bash' | 'powershell'; bin: string; label: string; os: 'Linux' | 'macOS' | 'Windows' }

const exists = (p?: string | null): p is string => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };
const onPath = (exe: string) => (process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, exe)).find(exists);

let shellCache: ShellInfo | null = null;
export function shell(): ShellInfo {
  if (shellCache) return shellCache;
  const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const forced = process.env.AUDA_SHELL;
  if (config.computerDriver !== 'local') return (shellCache = { kind: 'bash', bin: 'bash', label: 'bash', os: 'Linux' });
  if (process.platform !== 'win32') return (shellCache = { kind: 'bash', bin: forced || 'bash', label: 'bash', os });
  if (forced && /pwsh|powershell/i.test(forced)) return (shellCache = { kind: 'powershell', bin: forced, label: 'PowerShell', os });
  // Windows: Git Bash gives agents the Unix tools they know (ls, grep, sed, find…). WSL's bash.exe is a different
  // filesystem, so it's skipped. Without Git, PowerShell.
  const git = onPath('git.exe');
  const bash = [
    forced,
    git && path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe'),       // …\Git\cmd\git.exe → …\Git\bin\bash.exe
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)']!, 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].find((p) => exists(p) && !/system32/i.test(p!));
  if (bash) return (shellCache = { kind: 'bash', bin: bash, label: 'Git Bash', os });
  const pwsh = onPath('pwsh.exe');
  return (shellCache = { kind: 'powershell', bin: pwsh ?? 'powershell.exe', label: pwsh ? 'PowerShell 7' : 'Windows PowerShell', os });
}

const SAFE_ENV_KEYS = ['PATH', 'LANG', 'TERM', 'TZ', 'USER', 'SHELL'];
// What Windows programs (node, python, git, PowerShell itself) need to start and reach the network.
const WINDOWS_ENV_KEYS = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'HOMEDRIVE', 'HOMEPATH', 'PSModulePath'];
export function sanitizedEnv(): NodeJS.ProcessEnv {
  // Credentials never enter AUDA's computer through the environment.
  const env: NodeJS.ProcessEnv = {};
  for (const k of [...SAFE_ENV_KEYS, ...(process.platform === 'win32' ? WINDOWS_ENV_KEYS : [])]) if (process.env[k]) env[k] = process.env[k];
  env.HOME = config.workspaceDir;
  env.TERM = 'xterm-256color';
  env.AUDA_COMPUTER = '1';
  return env;
}

/** PowerShell: UTF-8 output, and a non-zero exit code when the command failed (cmdlet or program). */
const psWrap = (cmd: string) => `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; & { ${cmd} }; if (-not $?) { exit 1 } elseif ($LASTEXITCODE) { exit $LASTEXITCODE }`;

function argv(cmd: string, cwd: string): [string, string[]] {
  switch (config.computerDriver) {
    case 'docker':
      return ['docker', ['exec', '-w', cwd.replace(config.workspaceDir, '/home/auda'), process.env.AUDA_COMPUTER_CONTAINER ?? 'auda-computer', 'bash', '-lc', cmd]];
    case 'ssh':
      return ['ssh', ['-o', 'BatchMode=yes', process.env.AUDA_COMPUTER_SSH ?? 'auda@auda-computer', `cd ${JSON.stringify(cwd.replace(config.workspaceDir, '~'))} && ${cmd}`]];
    default: {
      const sh = shell();
      return sh.kind === 'powershell' ? [sh.bin, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psWrap(cmd)]] : [sh.bin, ['-lc', cmd]];
    }
  }
}

export function exec(cmd: string, opts: { cwd?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<ExecResult> {
  const cwd = opts.cwd ?? config.workspaceDir;
  const max = opts.maxBytes ?? 64_000;
  const started = Date.now();
  return new Promise((resolve) => {
    const [bin, args] = argv(cmd, cwd);
    const child = spawn(bin, args, { cwd: config.computerDriver === 'local' ? cwd : undefined, env: sanitizedEnv(), windowsHide: true });
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
  shell: shell().label, os: shell().os,
  label: { local: 'Local workspace', docker: 'Docker container', ssh: 'Dedicated VM (SSH)' }[config.computerDriver],
  home: config.workspaceDir,
});
