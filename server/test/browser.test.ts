/**
 * AUDA's browser against a page that behaves like a real shop: it refuses
 * "HeadlessChrome", hides its prices behind a cookie banner, loads more
 * results as you scroll, and has a search box, product pages and a "buy"
 * button. Runs wherever a Chrome/Chromium/Edge is installed (CI: Linux and
 * Windows); skipped otherwise, without downloading one.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.AUDA_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-browser-test-'));
process.env.AUDA_BROWSER_AUTOINSTALL = '0';
process.env.AUDA_BROWSER_LOCALE = 'es-ES';
const { findChromium } = await import('../src/core/config.ts');
const browser = await import('../src/computer/browser.ts');
const { ensureBrowserBinary } = await import('../src/computer/browser-install.ts');

const page = (title: string, body: string) => `<!doctype html><html lang="es"><meta charset="utf-8"><title>${title}</title><body>${body}</body></html>`;
const srv = http.createServer((req, res) => {
  const ua = String(req.headers['user-agent'] ?? '');
  const url = new URL(req.url ?? '/', 'http://x');
  if (/HeadlessChrome/.test(ua)) { res.writeHead(403, { 'content-type': 'text/html' }); res.end(page('Blocked', 'Robot check')); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (url.pathname === '/') res.end(page('Tienda de prueba', `
    <nav>${Array.from({ length: 30 }, (_, i) => `<a href="/c/${i}">Categoría ${i}</a>`).join(' ')}</nav>
    <div id="consent" style="position:fixed;inset:0;background:#fff"><p>Usamos cookies.</p><button onclick="document.getElementById('consent').remove();document.getElementById('deal').textContent='Meta Quest 3 512GB — precio 549,00 € · Envío gratis en 24 h'">Aceptar todo</button></div>
    <main><h1>Ofertas</h1><p id="lang">Idioma: ${req.headers['accept-language']}</p><p id="deal">Acepta las cookies para ver precios</p><div id="more"></div>
    <form action="/search"><input name="q" placeholder="Buscar productos"><button>Buscar</button></form>
    <div style="height:3000px"></div><p id="end"></p></main>
    <footer>${'Aviso legal. '.repeat(400)}</footer>
    <script>addEventListener('scroll', () => { document.getElementById('end').textContent = 'Más resultados: Meta Quest 3 128GB — precio 449,00 €'; }, { once: true });</script>`));
  else if (url.pathname === '/search') res.end(page(`Resultados: ${url.searchParams.get('q')}`, `<main><h1>Resultados para “${url.searchParams.get('q')}”</h1><a href="/p/1">Meta Quest 3 512GB</a><a href="/p/2">Funda Quest 3</a></main>`));
  else if (url.pathname === '/p/1') res.end(page('Meta Quest 3 512GB', `<main><h1>Meta Quest 3 512GB</h1><p>Precio: 549,00 €</p><p>Entrega: mañana</p><button>Comprar ahora</button></main>`));
  else res.end(page('Otra', '<main>otra página</main>'));
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(srv.address() as any).port}`;
const hasBrowser = Boolean(process.env.AUDA_CHROMIUM || findChromium());
after(async () => { await browser.shutdown(); srv.close(); });

test('finds an installed browser, and says how to get one when there is none', { skip: !hasBrowser && 'no Chrome/Chromium/Edge on this machine' }, async () => {
  assert.ok(fs.existsSync(await ensureBrowserBinary()));
});

test('reads a shop like a person: real Chrome identity, cookie banner accepted, lazy results loaded, page language', { skip: !hasBrowser && 'no browser' }, async () => {
  const r = await browser.readPage(`${base}/`);
  assert.equal(r.title, 'Tienda de prueba', 'not blocked as HeadlessChrome');
  assert.match(r.text, /549,00 € · Envío gratis/, 'the cookie banner was accepted, revealing the price');
  assert.match(r.text, /Más resultados: Meta Quest 3 128GB/, 'scrolling loaded the lazy content');
  assert.match(r.text, /Idioma: es-ES/);
  assert.ok(!/Aviso legal/.test(r.text), 'the <main> content is preferred over the footer');
  assert.ok(r.links.length > 0 && r.links.length <= 40);
});

test('focus returns only the passages that matter, keeping the model’s context small', { skip: !hasBrowser && 'no browser' }, async () => {
  const r = await browser.readPage(`${base}/`, 'precio');
  assert.match(r.text, /^\[passages mentioning: precio\]/);
  assert.match(r.text, /549,00/);
  assert.ok(r.text.length < 1500, `focused text is short: ${r.text.length}`);
});

test('acts like a person: types in the search box, opens a result, and treats "buy" as a submission', { skip: !hasBrowser && 'no browser' }, async () => {
  await browser.readPage(`${base}/`);
  const s = await browser.act({ action: 'type', target: 'Buscar productos', value: 'quest 3', submit: true });
  assert.match(s.url, /\/search\?q=quest\+3/);
  assert.match(s.text, /Resultados para “quest 3”/);
  const p = await browser.act({ action: 'click', target: 'Meta Quest 3 512GB', focus: 'precio, entrega' });
  assert.match(p.url, /\/p\/1$/);
  assert.match(p.text, /Precio: 549,00 €/);
  assert.match(p.text, /Entrega: mañana/);
  await assert.rejects(browser.act({ action: 'click', target: 'Botón inexistente' }), /Couldn’t find anything to click/);
  assert.equal(browser.isSubmission({ action: 'click', target: 'Comprar ahora' }), true);
  assert.equal(browser.isSubmission({ action: 'click', target: 'Meta Quest 3 512GB' }), false);
  const back = await browser.act({ action: 'back' });
  assert.match(back.url, /\/search/);
});
