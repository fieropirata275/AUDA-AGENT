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
