/** Filesystem access confined to AUDA's workspace. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { config } from '../core/config.ts';

export function resolveWs(p: string) {
  const clean = p.replace(/^~\/?/, '');
  const abs = path.resolve(config.workspaceDir, clean);
  if (abs !== config.workspaceDir && !abs.startsWith(config.workspaceDir + path.sep)) throw new Error(`Path is outside AUDA’s workspace: ${p}`);
  return abs;
}
export const display = (abs: string) => '~/' + path.relative(config.workspaceDir, abs).split(path.sep).join('/');

export interface Entry { name: string; path: string; dir: boolean; size: number; mtime: number }

export function list(dir = '~'): Entry[] {
  const abs = resolveWs(dir);
  return fs.readdirSync(abs, { withFileTypes: true })
    .filter((d) => !d.name.startsWith('.'))
    .map((d) => {
      const full = path.join(abs, d.name);
      let st: fs.Stats | undefined;
      try { st = fs.statSync(full); } catch { /* vanished */ }
      return { name: d.name, path: display(full), dir: d.isDirectory(), size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 };
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export function dirSize(dir: string): number {
  const abs = resolveWs(dir);
  let total = 0;
  const walk = (p: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(p, e.name);
      try { if (e.isDirectory()) walk(f); else total += fs.statSync(f).size; } catch { /* vanished */ }
    }
  };
  walk(abs);
  return total;
}

export function read(p: string, maxBytes = 200_000): { text: string; truncated: boolean; size: number } {
  const abs = resolveWs(p);
  const size = fs.statSync(abs).size;
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(Math.min(size, maxBytes));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  return { text: buf.toString('utf8'), truncated: size > maxBytes, size };
}

export function write(p: string, content: string) {
  const abs = resolveWs(p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return { path: display(abs), size: Buffer.byteLength(content) };
}

export function remove(paths: string[]) {
  let freed = 0;
  for (const p of paths) {
    const abs = resolveWs(p);
    try { freed += fs.statSync(abs).size; fs.rmSync(abs, { force: true }); } catch { /* already gone: idempotent */ }
  }
  return { removed: paths.length, freed };
}

export async function gzip(paths: string[]) {
  let before = 0, after = 0;
  const out: string[] = [];
  for (const p of paths) {
    const abs = resolveWs(p);
    if (!fs.existsSync(abs)) { if (fs.existsSync(abs + '.gz')) out.push(display(abs + '.gz')); continue; }
    before += fs.statSync(abs).size;
    await pipeline(fs.createReadStream(abs), zlib.createGzip({ level: 6 }), fs.createWriteStream(abs + '.gz'));
    after += fs.statSync(abs + '.gz').size;
    fs.rmSync(abs);
    out.push(display(abs + '.gz'));
  }
  return { files: out, before, after };
}

/** `ls -la`, portable: directories first, then files, with size and modification time. */
export function listDir(abs: string, max = 200): string {
  const st = fs.statSync(abs);
  if (!st.isDirectory()) return `${fmtSize(st.size).padStart(8)}  ${new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}  ${path.basename(abs)}`;
  const rows = fs.readdirSync(abs, { withFileTypes: true }).map((d) => {
    let s: fs.Stats | undefined;
    try { s = fs.statSync(path.join(abs, d.name)); } catch { /* vanished or a broken link */ }
    return { name: d.name, dir: d.isDirectory(), size: s?.size ?? 0, mtime: s?.mtimeMs ?? 0 };
  }).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  const lines = rows.slice(0, max).map((r) => `${r.dir ? '     dir' : fmtSize(r.size).padStart(8)}  ${new Date(r.mtime).toISOString().slice(0, 16).replace('T', ' ')}  ${r.name}${r.dir ? '/' : ''}`);
  return `${display(abs)} (${rows.length} entr${rows.length === 1 ? 'y' : 'ies'})\n${lines.join('\n')}${rows.length > max ? `\n… ${rows.length - max} more` : ''}`;
}
const fmtSize = (b: number) => b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)}G` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)}M` : b >= 1024 ? `${(b / 1024).toFixed(1)}K` : `${b}B`;

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target']);
/** `grep -rnE`, portable: matching lines as path:line:text, skipping dependency folders and binary or huge files. */
export function searchFiles(abs: string, pattern: string, max = 300): string {
  let re: RegExp;
  try { re = new RegExp(pattern); } catch (e) { throw new Error(`Invalid search pattern: ${(e as Error).message}`); }
  const out: string[] = [];
  const base = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const visit = (p: string) => {
    if (out.length >= max) return;
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      if (p !== abs && SKIP_DIRS.has(path.basename(p))) return;
      let names: string[] = [];
      try { names = fs.readdirSync(p).sort(); } catch { return; }
      for (const n of names) visit(path.join(p, n));
      return;
    }
    if (st.size > 2 * 1024 * 1024) return;
    let buf: Buffer;
    try { buf = fs.readFileSync(p); } catch { return; }
    if (buf.subarray(0, 4096).includes(0)) return; // binary
    const rel = path.relative(base, p).split(path.sep).join('/') || path.basename(p);
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < max; i++) if (re.test(lines[i])) out.push(`${rel}:${i + 1}:${lines[i].slice(0, 300)}`);
  };
  visit(abs);
  return out.length ? out.join('\n') + (out.length >= max ? `\n… stopped at ${max} matches` : '') : 'no matches';
}

/** The largest files under a directory, paths relative to it (portable `find -printf '%s %P' | sort -rn`). */
export function largestFiles(dir: string, max = 40): { size: number; path: string }[] {
  const abs = resolveWs(dir);
  const out: { size: number; path: string }[] = [];
  const walk = (p: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(p, e.name);
      try { if (e.isDirectory()) walk(f); else out.push({ size: fs.statSync(f).size, path: path.relative(abs, f).split(path.sep).join('/') }); } catch { /* vanished */ }
    }
  };
  walk(abs);
  return out.sort((a, b) => b.size - a.size).slice(0, max);
}

/** The last lines of a text file (portable `tail -n`), each cut to `width` characters. */
export function tailFile(file: string, n = 3, width = 140): string {
  try {
    const abs = resolveWs(file);
    const size = fs.statSync(abs).size;
    const fd = fs.openSync(abs, 'r');
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-n).map((l) => l.slice(0, width)).join('\n');
  } catch { return ''; }
}

/** Free space on the volume holding the workspace (portable `df -h .`). */
export function diskFree(dir = '~'): { totalBytes: number; freeBytes: number; text: string } | null {
  try {
    const s = fs.statfsSync(resolveWs(dir));
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    const g = (b: number) => `${(b / 1024 ** 3).toFixed(1)}G`;
    return { totalBytes: total, freeBytes: free, text: `disk ${g(total)} · ${g(free)} free · ${Math.round(((total - free) / total) * 100)}% used` };
  } catch { return null; }
}
