/**
 * The pieces that replaced Unix tools so AUDA runs the same on Linux, macOS and
 * Windows: listing and searching files, sizes and tails for the health
 * playbook, reading Office files without `unzip`, and the shell choice.
 * (CI runs these on Linux and Windows.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-portable-'));
process.env.AUDA_DATA = dir;
const { config } = await import('../src/core/config.ts');
const { listDir, searchFiles, largestFiles, tailFile, diskFree, resolveWs } = await import('../src/computer/files.ts');
const { zipTexts } = await import('../src/office/zip.ts');
const { shell } = await import('../src/computer/driver.ts');
const JSZip = (await import('jszip')).default;

const ws = config.workspaceDir;
fs.mkdirSync(path.join(ws, 'proj', 'src'), { recursive: true });
fs.mkdirSync(path.join(ws, 'proj', 'node_modules', 'dep'), { recursive: true });
fs.writeFileSync(path.join(ws, 'proj', 'src', 'a.ts'), 'const x = 1;\n// TODO: tidy\nexport { x };\n');
fs.writeFileSync(path.join(ws, 'proj', 'src', 'b.txt'), 'nothing here\r\nTODO later\r\n');
fs.writeFileSync(path.join(ws, 'proj', 'node_modules', 'dep', 'i.js'), '// TODO in a dependency\n');
fs.writeFileSync(path.join(ws, 'proj', 'big.bin'), Buffer.alloc(5000, 0));
fs.writeFileSync(path.join(ws, 'proj', 'log.txt'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');

test('listDir: directories first, sizes, and the workspace-relative path', () => {
  const out = listDir(resolveWs('proj'));
  const lines = out.split('\n');
  assert.match(lines[0], /^~\/proj \(4 entries\)$/);
  assert.match(lines[1], /dir .*node_modules\/$/);
  assert.match(out, /4\.9K .*big\.bin/);
});

test('searchFiles: path:line:text, CRLF-safe, skipping dependencies and binaries', () => {
  const out = searchFiles(resolveWs('proj'), 'TODO');
  assert.deepEqual(out.split('\n'), ['src/a.ts:2:// TODO: tidy', 'src/b.txt:2:TODO later']);
  assert.equal(searchFiles(resolveWs('proj'), 'nope-never'), 'no matches');
  assert.throws(() => searchFiles(resolveWs('proj'), '('), /Invalid search pattern/);
});

test('sizes, largest files, tail and free space without du/find/tail/df', () => {
  const top = largestFiles('proj', 2);
  assert.equal(top[0].path, 'big.bin');
  assert.equal(top[0].size, 5000);
  assert.equal(tailFile('proj/log.txt', 2), 'line 49\nline 50');
  assert.equal(tailFile('proj/missing.log'), '');
  const df = diskFree('proj');
  assert.ok(df && df.totalBytes > 0 && /free/.test(df.text));
  assert.throws(() => resolveWs(process.platform === 'win32' ? 'C:\\Windows' : '/etc'), /outside/);
});

test('Office files are read in-process, slides in natural order', async () => {
  const zip = new JSZip();
  for (const n of [1, 2, 10]) zip.file(`ppt/slides/slide${n}.xml`, `<a:t>Slide ${n}</a:t>`);
  zip.file('ppt/slides/_rels/slide1.xml.rels', '<x/>');
  const file = path.join(dir, 't.pptx');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const got = await zipTexts(file, /^ppt\/slides\/slide\d+\.xml$/);
  assert.deepEqual(got.map((g) => g.name), ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide10.xml']);
});

test('the shell matches the platform', () => {
  const sh = shell();
  if (process.platform === 'win32') assert.ok(sh.kind === 'powershell' || sh.label === 'Git Bash', JSON.stringify(sh));
  else assert.deepEqual([sh.kind, sh.os], ['bash', process.platform === 'darwin' ? 'macOS' : 'Linux']);
});
