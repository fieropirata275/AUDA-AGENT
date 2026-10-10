#!/usr/bin/env node
/**
 * End-to-end test of AUDA as a general computer operator: an agent researches
 * on the web, then delivers a spreadsheet with formulas, a chart, a designed
 * PDF report (with a contents page, the chart and an inlined image), a slide
 * deck (PowerPoint + PDF + HTML), and a Word document — and reads its own PDF
 * back. Checks every file's structure and the sandboxing of HTML artifacts.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = 4695, SEARCH = 4722;
const BASE = `http://localhost:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-e2e-office-'));
const root = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`  ✓ ${m}`);
const must = (c, m) => { if (!c) throw new Error(m); };

// A DuckDuckGo-shaped results page (redirect links included).
let searches = 0;
const search = http.createServer((req, res) => {
  searches++;
  const q = new URL(req.url, 'http://x').searchParams.get('q');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<html><body>
    <div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://benchmarks.example.org/saas-2026')}&amp;rut=x">SaaS revenue benchmarks 2026 &amp; growth</a>
    <a class="result__snippet" href="#">Median growth for <b>${q}</b> was 18% year over year.</a></div>
    <div class="result"><a rel="nofollow" class="result__a" href="https://stats.example.com/q3">Q3 market statistics</a><a class="result__snippet">Regional splits for EMEA, Americas and APAC.</a></div>
  </body></html>`);
});

let core, logs = '';
const boot = () => {
  core = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: root, env: { ...process.env, AUDA_DATA: data, AUDA_PORT: String(PORT), AUDA_MOCK_MODEL: path.join(root, 'scripts/mock-model.mjs'), AUDA_SEARCH_URL: `http://127.0.0.1:${SEARCH}/html/` }, stdio: ['ignore', 'pipe', 'pipe'] });
  core.stdout.on('data', (d) => { logs += d; }); core.stderr.on('data', (d) => { logs += d; });
};
const api = async (p, body) => { const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${j.error}`); return j; };
const send = async (method, p, body) => { const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${method} ${p}: ${j.error}`); return j; };
const raw = (id) => fetch(`${BASE}/api/artifacts/${id}/raw`);

let failed = false;
try {
  await new Promise((r) => search.listen(SEARCH, '127.0.0.1', r));
  boot();
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* booting */ } await sleep(500); }
  step('core booted (scripted model, fake search engine)');

  const { id } = await api('/api/tasks', { title: 'Quarterly pack', goal: 'Research benchmarks and deliver the quarterly pack: spreadsheet, chart, PDF report, deck and Word document', criteria: 'All five deliverables exist and the report cites sources' });
  let t;
  for (let i = 0; i < 240; i++) { t = await api(`/api/tasks/${id}`); if (['COMPLETED', 'FAILED'].includes(t.state)) break; await sleep(500); }
  must(t.state === 'COMPLETED', `task ended ${t.state}: ${t.diagnosis ?? t.error}\n${logs.split('\n').slice(-30).join('\n')}`);
  must(/read back OK/.test(t.result) && !/\? pages/.test(t.result), `the agent should read its PDF back: ${t.result}`);
  must(searches >= 1, 'search_web should have hit the search engine');
  step(`agent finished: “${t.result}”`);

  const arts = (await api('/api/bootstrap')).artifacts.filter((a) => a.taskId === id);
  const by = (name) => arts.find((a) => a.name === name);
  const names = arts.map((a) => a.name).sort();
  for (const n of ['revenue-model.xlsx', 'revenue-by-region.svg', 'revenue-by-region.png', 'quarterly-report.pdf', 'quarterly-review.pptx', 'quarterly-review.pdf', 'quarterly-review.html', 'quarterly-report.docx']) must(by(n), `missing ${n}; have ${names.join(', ')}`);
  step(`${arts.length} deliverables saved: ${names.join(', ')}`);

  // PDF report: real PDF, several pages, text extractable, source cited.
  const pdfBytes = Buffer.from(await (await raw(by('quarterly-report.pdf').id)).arrayBuffer());
  must(pdfBytes.subarray(0, 5).toString() === '%PDF-', 'report is not a PDF');
  const pdfPrev = await api(`/api/artifacts/${by('quarterly-report.pdf').id}/preview`);
  must(pdfPrev.pages >= 3 && /Executive summary/.test(pdfPrev.text) && /benchmarks\.example\.org/.test(pdfPrev.text), `PDF content: ${pdfPrev.pages} pages, ${pdfPrev.text.slice(0, 200)}`);
  must(pdfBytes.length > 20_000, 'the PDF should embed the chart image and fonts');
  step(`PDF report: ${pdfPrev.pages} pages (cover, contents, body), cites ${/benchmarks\.example\.org\S*/.exec(pdfPrev.text)[0]}, ${(pdfBytes.length / 1024).toFixed(0)} KB`);

  // Deck: PowerPoint with slides + notes, PDF with one page per slide, HTML sandboxed.
  const pptPrev = await api(`/api/artifacts/${by('quarterly-review.pptx').id}/preview`);
  must(pptPrev.kind === 'presentation' && pptPrev.pages === 4 && /Americas leads/.test(pptPrev.text), `pptx: ${JSON.stringify(pptPrev).slice(0, 200)}`);
  must(pptPrev.siblings.some((s) => s.name === 'quarterly-review.pdf') && pptPrev.siblings.some((s) => s.name === 'quarterly-review.html'), 'deck formats should be linked as siblings');
  const deckPdf = await api(`/api/artifacts/${by('quarterly-review.pdf').id}/preview`);
  must(deckPdf.pages === 4, `deck PDF should have 4 pages: ${deckPdf.pages}`);
  const html = await raw(by('quarterly-review.html').id);
  const csp = html.headers.get('content-security-policy') ?? '';
  must(/sandbox allow-scripts/.test(csp) && !/allow-same-origin/.test(csp), `HTML artifacts must be sandboxed: ${csp}`);
  must((await html.text()).includes('Americas leads'), 'HTML deck content');
  step('deck: PowerPoint (4 slides, chart, notes) + 4-page PDF + HTML deck served in a sandboxed origin');

  // Spreadsheet: formulas + totals; Word: headings and table.
  const xl = await api(`/api/artifacts/${by('revenue-model.xlsx').id}/preview`);
  const rows = xl.sheets[0].rows;
  must(rows[0][0] === 'Region' && rows[1][3] === '=B2*(1+C2)' && rows[4][0] === 'Total' && String(rows[4][3]).startsWith('=SUM('), `xlsx rows: ${JSON.stringify(rows)}`);
  const docx = await api(`/api/artifacts/${by('quarterly-report.docx').id}/preview`);
  must(/Executive summary/.test(docx.text) && /Americas/.test(docx.text), `docx: ${docx.text.slice(0, 160)}`);
  const png = Buffer.from(await (await raw(by('revenue-by-region.png').id)).arrayBuffer());
  must(png.subarray(1, 4).toString() === 'PNG', 'chart PNG');
  step('spreadsheet with formulas and a SUM totals row; Word document with headings and table; chart as SVG + PNG');

  // A website built in files and "saved" as a description: the artifact must be the real page, bundled.
  const { id: siteId } = await api('/api/tasks', { title: 'Build a website', goal: 'Build a modern website', criteria: 'The page is delivered' });
  let site;
  for (let i = 0; i < 120; i++) { site = await api(`/api/tasks/${siteId}`); if (['COMPLETED', 'FAILED'].includes(site.state)) break; await sleep(500); }
  must(site.state === 'COMPLETED', `website task: ${site.state} ${site.diagnosis ?? ''}`);
  must(site.verification?.verdict === 'pass', `the review ran despite an empty first reply: ${JSON.stringify(site.verification)}`);
  const siteArts = (await api('/api/bootstrap')).artifacts.filter((a) => a.taskId === siteId);
  const page = siteArts.find((a) => a.name === 'modern-website.html');
  must(page, `artifact saved: ${siteArts.map((a) => a.name).join(', ')}`);
  const pageHtml = await (await raw(page.id)).text();
  must(/<style>[\s\S]*#f5a524[\s\S]*<\/style>/.test(pageHtml) && /<script>[\s\S]*dataset\.ready/.test(pageHtml) && /src="data:image\/svg\+xml;base64,/.test(pageHtml) && /url\("data:image\/svg/.test(pageHtml), `the page is bundled with its CSS, JS and images: ${pageHtml.slice(0, 300)}`);
  must(!/View at:/.test(pageHtml), 'the description was not saved as the page');
  must(siteArts.some((a) => a.name === 'README.md') && !siteArts.some((a) => a.name === 'style.css' || a.name === 'app.js'), `written files delivered, inlined assets not duplicated: ${siteArts.map((a) => a.name).join(', ')}`);
  must(/Files: /.test(site.result), `the answer lists the delivered files: ${site.result}`);
  step(`website: a description pointing at ~/…/site/index.html became the real page (CSS, JS and images inlined); README.md delivered on finish; review recovered from an empty reply (${site.verification.verdict})`);

  // Chat like ChatGPT: each message is a live run; the reply is Markdown, follow-ups see the conversation, files come back in the reply.
  const replyTo = async (cid, mid) => {
    for (let i = 0; i < 120; i++) {
      const m = (await api(`/api/conversations/${cid}/messages`)).find((x) => x.id === mid);
      const run = m?.objects.find((o) => o.type === 'run');
      if (m && run && m.content) return { m, run: await api(`/api/tasks/${run.id}`) };
      await sleep(500);
    }
    throw new Error('no chat reply');
  };
  const chat1 = await api('/api/chat', { text: 'When does the next iPhone come out?' });
  const cid = chat1.conversationId;
  const replyId = (await api(`/api/conversations/${cid}/messages`)).find((m) => m.role === 'auda').id;
  const a1 = await replyTo(cid, replyId);
  must(/\| iPhone 19 \| \*\*September\*\* \|/.test(a1.m.content) && a1.run.state === 'COMPLETED' && !a1.run.verification, `a chat answer is the Markdown reply, without a review: ${a1.m.content}`);
  await api('/api/chat', { text: 'How much will it cost?', conversationId: cid });
  const r2 = (await api(`/api/conversations/${cid}/messages`)).filter((m) => m.role === 'auda').at(-1);
  const a2 = await replyTo(cid, r2.id);
  must(/\$799/.test(a2.m.content), `the follow-up saw the conversation: ${a2.m.content}`);
  await api('/api/chat', { text: 'Make a CSV of squares with Python', conversationId: cid });
  const r3 = (await api(`/api/conversations/${cid}/messages`)).filter((m) => m.role === 'auda').at(-1);
  const a3 = await replyTo(cid, r3.id);
  const att = a3.m.objects.filter((o) => o.type === 'artifact');
  const csv = (await api('/api/bootstrap')).artifacts.find((a) => a.id === att[0]?.id);
  must(csv?.name === 'squares.csv' && !/not attached/.test(a3.m.content), `the file Python made is attached to the reply: ${JSON.stringify(a3.m.objects)} ${a3.m.content}`);
  must((await (await raw(csv.id)).text()).includes('5,25'), 'the CSV content');
  const steps = (await api('/api/bootstrap')).activity.filter((x) => x.taskId === a3.run.id && x.kind === 'act').map((x) => x.title);
  must(steps.includes('Writing the squares table with Python'), `what it is doing is shown as it works: ${steps.join(' | ')}`);
  step(`chat: Markdown answer, follow-up with context (“${a2.m.content}”), Python's squares.csv attached to the reply, live step “${steps.find((x) => /Python/.test(x))}”`);

  await send('PATCH', `/api/conversations/${cid}`, { title: 'iPhone questions', pinned: true });
  let conv = (await api('/api/bootstrap')).conversations.find((c) => c.id === cid);
  must(conv.title === 'iPhone questions' && conv.pinned === 1, `rename + pin: ${JSON.stringify(conv)}`);
  await send('DELETE', `/api/conversations/${cid}`);
  conv = (await api('/api/bootstrap')).conversations.find((c) => c.id === cid);
  must(!conv && (await api(`/api/conversations/${cid}/messages`)).length === 0, 'the conversation and its messages are deleted');
  step('conversations: renamed, pinned, deleted');

  console.log('\n  office work (research, PDF, slides, Word, Excel, charts): PASS\n');
} catch (e) {
  failed = true;
  console.error(`\n  ✕ ${e.message}\n`);
  console.error(logs.split('\n').slice(-25).join('\n'));
} finally {
  core?.kill('SIGTERM');
  search.close();
  await sleep(500);
  fs.rmSync(data, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
