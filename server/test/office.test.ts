/**
 * Unit tests for the office toolkit's deterministic parts: chart validation
 * and SVG output, Markdown → HTML (headings, charts, images), deck validation,
 * PowerPoint/Word/Excel generation round-trips, and search-result parsing.
 * (Chromium-based PDF rendering is covered end to end by scripts/e2e-office.mjs.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-office-test-'));
process.env.AUDA_DATA = dir;

const { chartSvg, validateChart } = await import('../src/office/charts.ts');
const { markdownToHtml } = await import('../src/office/render.ts');
const { validateDeck, deckToPptx, deckToHtml } = await import('../src/office/slides.ts');
const { sheetsToXlsx, markdownToDocx, readDocument } = await import('../src/office/documents.ts');
const { searchWeb } = await import('../src/office/search.ts');
const ExcelJS = (await import('exceljs')).default;

test('charts: validation fills defaults and rejects empty charts', () => {
  const c = validateChart({ type: 'nope', labels: [1, 2], values: ['3', 4] });
  assert.equal(c.type, 'bar');
  assert.deepEqual(c.labels, ['1', '2']);
  assert.deepEqual(c.series[0].values, [3, 4]);
  assert.throws(() => validateChart({ type: 'bar', labels: [], series: [] }), /labels/);
});

test('charts: every type renders well-formed SVG with escaped text', () => {
  for (const type of ['bar', 'hbar', 'line', 'area', 'pie', 'donut'] as const) {
    const svg = chartSvg({ type, title: 'A & <B>', labels: ['x', 'y', 'z'], series: [{ name: 'S1', values: [1, 5, 3] }, { name: 'S2', values: [2, 2, 2] }], unit: '%' });
    assert.match(svg, /^<svg[^>]+viewBox/);
    assert.match(svg, /<\/svg>$/);
    assert.ok(svg.includes('A &amp; &lt;B&gt;'), `${type}: title escaped`);
    assert.ok(!svg.includes('NaN'), `${type}: no NaN coordinates`);
  }
});

test('markdown: headings get ids, charts become SVG, missing images degrade gracefully', () => {
  const { html, headings } = markdownToHtml('## Results\ntext\n\n## Results\n```chart\n{"labels":["a"],"series":[{"name":"n","values":[1]}]}\n```\n\n![logo](nope.png)\n\n```chart\nnot json\n```');
  assert.deepEqual(headings.map((h) => h.id), ['results', 'results-1']);
  assert.match(html, /<figure class="chart"><svg/);
  assert.match(html, /\[image: logo\]/);
  assert.match(html, /Chart could not be drawn/);
});

test('slides: deck validation infers layouts; PowerPoint has every slide and its notes', async () => {
  const deck = validateDeck({ title: 'T', slides: [{ title: 'Hi', bullets: 'one' }, { chart: { labels: ['a'], series: [{ name: 'n', values: [1] }] } }, { stats: [{ value: '1', label: 'x' }] }, { quote: 'q' }] });
  assert.deepEqual(deck.slides.map((s) => s.layout), ['bullets', 'chart', 'stats', 'quote']);
  assert.deepEqual(deck.slides[0].bullets, ['one']);
  assert.throws(() => validateDeck({ slides: [] }), /at least one slide/);
  deck.slides[0].notes = 'Speak slowly';
  const file = path.join(dir, 't.pptx');
  fs.writeFileSync(file, await deckToPptx(deck));
  const r = await readDocument(file);
  assert.equal(r.pages, 4);
  assert.match(r.text, /Hi/);
  const html = deckToHtml(deck);
  assert.equal((html.match(/<section class="slide l-/g) ?? []).length, 4);
  assert.ok(!/class="slide (chart|stats|quote)"/.test(html), 'slide layout classes are prefixed so they never collide with inner elements');
});

test('spreadsheets: formulas, totals, formats and object rows round-trip', async () => {
  const buf = await sheetsToXlsx([
    { name: 'Data/2026', columns: [{ header: 'Item' }, { header: 'Qty', format: 'integer' }, { header: 'Price', format: 'currency' }, { header: 'Total', format: 'currency' }], rows: [['A', 2, 3.5, '=B2*C2'], ['B', 1, 10, '=B3*C3']], totals: true },
    { name: 'Notes', rows: [{ key: 'source', value: 'test' }] },
  ]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, 'Data 2026', 'illegal sheet-name characters are replaced');
  assert.deepEqual((ws.getCell('D2').value as any).formula, 'B2*C2');
  assert.equal(ws.getCell('A4').value, 'Total');
  assert.equal((ws.getCell('D4').value as any).formula, 'SUM(D2:D3)', 'formula columns are totalled too');
  assert.equal(ws.getCell('C2').numFmt, '"$"#,##0.00');
  assert.equal(ws.views[0].state, 'frozen', 'header row is frozen');
  assert.equal((ws.views[0] as any).ySplit, 1);
  const notes = wb.worksheets[1];
  assert.equal(notes.getCell('A1').value, 'key', 'object rows become columns named after their keys');
  assert.equal(notes.getCell('B1').value, 'value');
  assert.equal(notes.getCell('B2').value, 'test');
});

test('documents: Word output keeps headings, lists and tables readable', async () => {
  const file = path.join(dir, 't.docx');
  fs.writeFileSync(file, await markdownToDocx({ title: 'Doc', markdown: '## Section A\n- one\n- two\n\n| h1 | h2 |\n|---|---|\n| c1 | c2 |\n\n**bold** and [link](https://x.y)' }));
  const r = await readDocument(file);
  for (const s of ['Doc', 'Section A', 'one', 'two', 'c2', 'bold', 'link']) assert.ok(r.text.includes(s), `docx contains ${s}`);
});

test('search: parses DuckDuckGo-style results and unwraps redirect links', async () => {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fx&amp;rut=1">First &amp; best</a><a class="result__snippet">Snippet <b>one</b></a><a class="result__a" href="https://b.example/">Second</a>');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  process.env.AUDA_SEARCH_URL = `http://127.0.0.1:${(srv.address() as any).port}/html/`;
  try {
    const res = await searchWeb('anything');
    assert.equal(res.length, 2);
    assert.deepEqual(res[0], { title: 'First & best', url: 'https://a.example/x', snippet: 'Snippet one' });
    assert.equal(res[1].url, 'https://b.example/');
  } finally { srv.close(); delete process.env.AUDA_SEARCH_URL; }
});
