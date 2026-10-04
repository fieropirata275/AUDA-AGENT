/** AUDA's terminal: a persistent transcript of everything run on its computer. */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config.ts';
import { publish } from '../core/streams.ts';
import { exec, type ExecResult } from './driver.ts';

export interface TermLine { ts: number; actor: 'auda' | 'human'; kind: 'cmd' | 'out' | 'err' | 'note'; text: string; taskId?: string }

const file = path.join(config.dataDir, 'computer', 'terminal.jsonl');
let lines: TermLine[] = [];
try {
  lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-600).map((l) => JSON.parse(l));
} catch { /* fresh computer */ }

function push(l: TermLine) {
  lines.push(l);
  if (lines.length > 600) lines = lines.slice(-500);
  fs.appendFile(file, JSON.stringify(l) + '\n', () => {});
  publish('terminal', l);
}

export const transcript = () => lines.slice(-400);

export function note(text: string, actor: 'auda' | 'human' = 'auda') { push({ ts: Date.now(), actor, kind: 'note', text }); }

export async function run(cmd: string, opts: { actor?: 'auda' | 'human'; taskId?: string; cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  const actor = opts.actor ?? 'auda';
  const cwd = opts.cwd ? path.resolve(config.workspaceDir, opts.cwd) : config.workspaceDir;
  if (!cwd.startsWith(config.workspaceDir)) throw new Error('Commands must run inside AUDA’s workspace');
  push({ ts: Date.now(), actor, kind: 'cmd', text: cmd, taskId: opts.taskId });
  const r = await exec(cmd, { cwd, timeoutMs: opts.timeoutMs });
  const out = r.stdout.trimEnd();
  if (out) push({ ts: Date.now(), actor, kind: 'out', text: out.length > 4000 ? out.slice(0, 4000) + '\n…' : out, taskId: opts.taskId });
  if (r.stderr.trim()) push({ ts: Date.now(), actor, kind: 'err', text: r.stderr.trimEnd().slice(0, 2000), taskId: opts.taskId });
  if (r.timedOut) push({ ts: Date.now(), actor, kind: 'note', text: 'command timed out', taskId: opts.taskId });
  return r;
}
