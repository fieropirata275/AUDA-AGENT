/**
 * Model JSON that local models actually send (reasoning, fences, prose, nothing
 * at all), bundling an HTML page with its local assets into one artifact, and
 * repairing artifacts that saved a description instead of the page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AUDA_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-deliver-'));
const { config } = await import('../src/core/config.ts');
const { parseModelJson } = await import('../src/models/openai.ts');
const { bundleHtml } = await import('../src/artifacts/bundle.ts');
const { saveArtifact, artifactFile, repairPointerArtifacts } = await import('../src/artifacts/store.ts');

test('model JSON: reasoning, fences, prose and trailing commas are handled; nothing at all says so clearly', () => {
  assert.deepEqual(parseModelJson('<think>Let me check {the} criteria…</think>\n{"verdict":"pass","issues":[]}'), { verdict: 'pass', issues: [] });
  assert.deepEqual(parseModelJson('Here is my review:\n```json\n{"verdict": "fail", "issues": ["no test run",],}\n```\nHope that helps {x}'), { verdict: 'fail', issues: ['no test run'] });
  assert.deepEqual(parseModelJson('{"summary":"uses } and { inside strings","verdict":"pass"} trailing {"other":1}'), { summary: 'uses } and { inside strings', verdict: 'pass' });
  assert.throws(() => parseModelJson(''), /empty reply/);
  assert.throws(() => parseModelJson('<think>still thinking…'), /empty reply|without JSON/);
  assert.throws(() => parseModelJson('The task looks complete.'), /without JSON/);
});

const ws = config.workspaceDir;
const site = path.join(ws, 'work', 't1', 'site');
fs.mkdirSync(path.join(site, 'img'), { recursive: true });
fs.writeFileSync(path.join(site, 'index.html'), '<html><head><link rel="stylesheet" href="css/main.css"><link rel="stylesheet" href="https://cdn.example/x.css"></head><body><img src="img/a.png"><img src="https://x.example/b.png"><script src="app.js" defer></script><script src="https://cdn.example/lib.js"></script></body></html>');
fs.mkdirSync(path.join(site, 'css'));
fs.writeFileSync(path.join(site, 'css', 'main.css'), 'body{background:url(../img/a.png)}');
fs.writeFileSync(path.join(site, 'app.js'), 'console.log("</script>")');
fs.writeFileSync(path.join(site, 'img', 'a.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

test('bundling a page inlines its local CSS (with url()), JS and images, and leaves remote ones alone', () => {
  const { html, inlined } = bundleHtml(path.join(site, 'index.html'), ws);
  assert.match(html, /<style>\nbody\{background:url\("data:image\/png;base64,/);
  assert.match(html, /<script defer>\nconsole\.log\("<\\\/script>"\)\n<\/script>/);
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.match(html, /href="https:\/\/cdn\.example\/x\.css"/);
  assert.match(html, /src="https:\/\/cdn\.example\/lib\.js"/);
  assert.match(html, /src="https:\/\/x\.example\/b\.png"/);
  assert.deepEqual(inlined.map((p) => path.relative(site, p).split(path.sep).join('/')).sort(), ['app.js', 'css/main.css', 'img/a.png']);
});

test('an HTML artifact that saved a description instead of the page is repaired from the page it points to', () => {
  const bad = saveArtifact({ name: 'modern-website.html', content: 'Modern Website - Clean, Minimal Design. Sections: 1. Hero 2. Features. View at: ~/work/t1/site/index.html', why: 'test' });
  const good = saveArtifact({ name: 'real.html', content: '<!doctype html><p>fine</p> ~/work/t1/site/index.html', why: 'test' });
  assert.equal(repairPointerArtifacts(), 1);
  assert.match(fs.readFileSync(artifactFile(bad.id)!.abs, 'utf8'), /<style>[\s\S]*<img src="data:image\/png/);
  assert.match(fs.readFileSync(artifactFile(good.id)!.abs, 'utf8'), /<p>fine<\/p>/);
  assert.equal(repairPointerArtifacts(), 0, 'idempotent');
});
