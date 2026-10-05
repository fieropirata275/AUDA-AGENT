/**
 * Rendering service: Markdown → designed HTML → PDF, using a dedicated headless
 * Chromium (separate from the agent's own browser, so printing never disturbs
 * a browsing task).
 *
 * Safety: the print context has JavaScript disabled and every network request
 * blocked — agent-written HTML can't fetch anything. Local images are inlined
 * from the workspace as data URIs; ```chart blocks become SVG.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Marked, type Tokens } from 'marked';
import { chromium, type Browser } from 'playwright-core';
import { config } from '../core/config.ts';
import { log } from '../core/log.ts';
import { resolveWs } from '../computer/files.ts';
import { chartSvg, validateChart } from './charts.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const IMG_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

/** Inline a workspace image as a data URI (http(s) images are left out: the print context is offline). */
export function inlineImage(src: string): string | null {
  if (/^data:/.test(src)) return src;
  if (/^https?:/i.test(src)) return null;
  try {
    const abs = resolveWs(src.startsWith('~') ? src : `~/${src.replace(/^\.?\//, '')}`);
    const mime = IMG_MIME[path.extname(abs).toLowerCase()];
    if (!mime || !fs.existsSync(abs) || fs.statSync(abs).size > 15 * 1024 * 1024) return null;
    return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
  } catch { return null; }
}

// ─── fonts (embedded so documents look the same everywhere) ──────────────────
let fontCss: string | null = null;
function fonts() {
  if (fontCss !== null) return fontCss;
  const req = createRequire(import.meta.url);
  const face = (family: string, pkg: string, file: string, style = 'normal', weight = '100 900') => {
    try {
      const dir = path.dirname(req.resolve(`${pkg}/package.json`));
      const data = fs.readFileSync(path.join(dir, 'files', file)).toString('base64');
      return `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};src:url(data:font/woff2;base64,${data}) format('woff2');}`;
    } catch { return ''; }
  };
  fontCss = [
    face('AUDA Sans', '@fontsource-variable/instrument-sans', 'instrument-sans-latin-wght-normal.woff2'),
    face('AUDA Sans', '@fontsource-variable/instrument-sans', 'instrument-sans-latin-wght-italic.woff2', 'italic'),
    face('AUDA Serif', '@fontsource/instrument-serif', 'instrument-serif-latin-400-normal.woff2', 'normal', '400'),
    face('AUDA Serif', '@fontsource/instrument-serif', 'instrument-serif-latin-400-italic.woff2', 'italic', '400'),
    face('AUDA Mono', '@fontsource-variable/jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2'),
  ].join('');
  return fontCss;
}
export const fontFaces = () => fonts();

// ─── Markdown ────────────────────────────────────────────────────────────────
export interface Heading { level: number; text: string; id: string }

export function markdownToHtml(md: string): { html: string; headings: Heading[] } {
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  const slug = (t: string) => {
    const base = t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
    const n = used.get(base) ?? 0; used.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  const m = new Marked({ gfm: true, breaks: false });
  m.use({
    renderer: {
      heading(this: any, t: Tokens.Heading) {
        const text = this.parser.parseInline(t.tokens);
        const id = slug(t.text);
        if (t.depth <= 3) headings.push({ level: t.depth, text: t.text, id });
        return `<h${t.depth} id="${id}">${text}</h${t.depth}>\n`;
      },
      code(t: Tokens.Code) {
        if (t.lang === 'chart') {
          try { return `<figure class="chart">${chartSvg(validateChart(JSON.parse(t.text)))}</figure>\n`; }
          catch (e) { return `<pre class="err">Chart could not be drawn: ${esc((e as Error).message)}</pre>\n`; }
        }
        return `<pre><code${t.lang ? ` class="lang-${esc(t.lang)}"` : ''}>${esc(t.text)}</code></pre>\n`;
      },
      image(t: Tokens.Image) {
        const src = inlineImage(t.href);
        if (!src) return `<span class="missing-img">[image: ${esc(t.text || t.href)}]</span>`;
        return `<figure><img src="${src}" alt="${esc(t.text)}">${t.text ? `<figcaption>${esc(t.text)}</figcaption>` : ''}</figure>`;
      },
    },
  });
  return { html: m.parse(md) as string, headings };
}

// ─── document theme ──────────────────────────────────────────────────────────
export function documentCss(accent = '#c25e2c') {
  return `${fonts()}
  @page { size: A4; margin: 20mm 18mm 20mm 18mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font: 10.5pt/1.6 'AUDA Sans', system-ui, sans-serif; color: #2a2622; }
  h1, h2, h3, h4 { line-height: 1.2; color: #1d1a17; break-after: avoid; }
  h1 { font: 400 30pt/1.1 'AUDA Serif', Georgia, serif; margin: 0 0 12pt; letter-spacing: -0.01em; }
  h2 { font-size: 16pt; margin: 22pt 0 8pt; padding-bottom: 4pt; border-bottom: 1.5pt solid ${accent}22; }
  h3 { font-size: 12.5pt; margin: 16pt 0 6pt; }
  h4 { font-size: 11pt; margin: 12pt 0 4pt; color: #5a524a; }
  p { margin: 0 0 8pt; orphans: 3; widows: 3; }
  a { color: ${accent}; text-decoration: none; }
  /* Printed reports keep their citations: show where external links point. */
  main a[href^="http"]::after { content: " — " attr(href); font-size: 8pt; color: #8a8178; word-break: break-all; }
  ul, ol { margin: 0 0 8pt; padding-left: 18pt; } li { margin: 2pt 0; }
  blockquote { margin: 10pt 0; padding: 8pt 14pt; border-left: 3pt solid ${accent}; background: #f6f2ec; border-radius: 0 6pt 6pt 0; color: #4a433c; font-style: italic; }
  code { font: 9pt 'AUDA Mono', ui-monospace, monospace; background: #f3efe9; padding: 1pt 4pt; border-radius: 3pt; }
  pre { background: #1f1c19; color: #f4efe7; padding: 10pt 12pt; border-radius: 6pt; overflow: hidden; white-space: pre-wrap; break-inside: avoid; font-size: 8.5pt; }
  pre code { background: none; padding: 0; color: inherit; }
  pre.err { background: #fbe9e7; color: #9c2b1d; }
  table { width: 100%; border-collapse: collapse; margin: 8pt 0 12pt; font-size: 9.5pt; break-inside: auto; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th { text-align: left; font-weight: 650; color: #1d1a17; background: #f3efe9; border-bottom: 1.5pt solid ${accent}; padding: 5pt 7pt; }
  td { border-bottom: 0.75pt solid #e6e0d6; padding: 5pt 7pt; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #faf8f4; }
  th[align=right], td[align=right] { text-align: right; } th[align=center], td[align=center] { text-align: center; }
  figure { margin: 12pt 0; break-inside: avoid; text-align: center; }
  figure img { max-width: 100%; max-height: 120mm; border-radius: 4pt; }
  figure.chart svg { max-width: 100%; height: auto; }
  figcaption { font-size: 8.5pt; color: #8a8178; margin-top: 4pt; }
  hr { border: 0; border-top: 0.75pt solid #e6e0d6; margin: 16pt 0; }
  .missing-img { color: #8a8178; font-style: italic; }
  .cover { height: 245mm; display: flex; flex-direction: column; justify-content: flex-end; break-after: page; padding-bottom: 10mm; position: relative; }
  .cover::before { content: ''; position: absolute; top: 0; left: 0; width: 46pt; height: 46pt; border-radius: 50%; background: radial-gradient(circle at 36% 30%, #f3a06b, ${accent} 55%, #7a3415); box-shadow: inset 0 0 0 9pt #fff0, 0 6pt 18pt ${accent}44; }
  .cover .kicker { font-size: 9pt; font-weight: 650; letter-spacing: .12em; text-transform: uppercase; color: ${accent}; margin-bottom: 10pt; }
  .cover h1 { font-size: 40pt; margin-bottom: 10pt; }
  .cover .subtitle { font: italic 400 16pt/1.35 'AUDA Serif', Georgia, serif; color: #5a524a; max-width: 140mm; }
  .cover .meta { margin-top: 26pt; padding-top: 10pt; border-top: 0.75pt solid #e6e0d6; font-size: 9pt; color: #8a8178; display: flex; gap: 18pt; }
  .toc { break-after: page; }
  .toc h2 { border: 0; }
  .toc ol { list-style: none; padding: 0; }
  .toc li { display: flex; gap: 8pt; padding: 4pt 0; border-bottom: 0.5pt dotted #d8d0c4; }
  .toc li.l3 { padding-left: 14pt; font-size: 9.5pt; color: #5a524a; }
  .toc a { color: inherit; }
  `;
}

export function documentHtml(o: { title: string; subtitle?: string; author?: string; markdown: string; toc?: boolean; cover?: boolean; accent?: string }) {
  const { html, headings } = markdownToHtml(o.markdown);
  const date = new Date().toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' });
  const cover = o.cover === false ? '' : `<section class="cover"><div class="kicker">${esc(o.author ?? 'Prepared by AUDA')}</div><h1>${esc(o.title)}</h1>${o.subtitle ? `<div class="subtitle">${esc(o.subtitle)}</div>` : ''}<div class="meta"><span>${esc(date)}</span><span>${headings.filter((h) => h.level === 2).length} sections</span></div></section>`;
  const toc = o.toc && headings.length > 2 ? `<nav class="toc"><h2>Contents</h2><ol>${headings.filter((h) => h.level >= 2).map((h) => `<li class="l${h.level}"><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ol></nav>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.title)}</title><style>${documentCss(o.accent)}</style></head><body>${cover}${toc}<main>${o.cover === false ? `<h1>${esc(o.title)}</h1>` : ''}${html}</main></body></html>`;
}

// ─── Chromium print service ──────────────────────────────────────────────────
let browser: Browser | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<unknown> = Promise.resolve();

async function getBrowser() {
  if (!config.chromiumPath) throw new Error('Making PDFs needs Chromium on AUDA’s computer (set AUDA_CHROMIUM)');
  if (!browser || !browser.isConnected()) browser = await chromium.launch({ executablePath: config.chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  return browser;
}

/** Print HTML to PDF. Jobs are serialised; the browser closes after a minute idle. */
export function htmlToPdf(html: string, o: { landscape?: boolean; width?: string; height?: string; footer?: boolean; title?: string } = {}): Promise<Buffer> {
  const job = chain.then(async () => {
    if (idle) clearTimeout(idle);
    const b = await getBrowser();
    const ctx = await b.newContext({ javaScriptEnabled: false, offline: true });
    try {
      await ctx.route('**/*', (r) => (r.request().url().startsWith('data:') ? r.continue() : r.abort()));
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: 60_000 });
      const footer = o.footer !== false && !o.width;
      return await page.pdf({
        printBackground: true, preferCSSPageSize: !o.width, landscape: o.landscape,
        ...(o.width ? { width: o.width, height: o.height } : {}),
        displayHeaderFooter: footer,
        headerTemplate: '<span></span>',
        footerTemplate: footer ? `<div style="width:100%;font:7.5pt system-ui,sans-serif;color:#9a9086;padding:0 18mm;display:flex;justify-content:space-between"><span>${esc(o.title ?? '')}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>` : '<span></span>',
      });
    } finally {
      await ctx.close().catch(() => {});
      idle = setTimeout(() => { void browser?.close().catch(() => {}); browser = null; }, 60_000);
      idle.unref?.();
    }
  });
  chain = job.catch((e) => log.warn('pdf render failed', String(e)));
  return job;
}

/** Rasterise an SVG (charts for Word, previews) to PNG with the same offline print browser. */
export function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Buffer> {
  const job = chain.then(async () => {
    if (idle) clearTimeout(idle);
    const b = await getBrowser();
    const ctx = await b.newContext({ javaScriptEnabled: false, offline: true, viewport: { width, height }, deviceScaleFactor: scale });
    try {
      await ctx.route('**/*', (r) => (r.request().url().startsWith('data:') ? r.continue() : r.abort()));
      const page = await ctx.newPage();
      await page.setContent(`<!doctype html><html><head><style>${fonts()} html,body{margin:0;background:#fff}</style></head><body>${svg}</body></html>`, { waitUntil: 'load' });
      return await page.screenshot({ clip: { x: 0, y: 0, width, height }, type: 'png' });
    } finally {
      await ctx.close().catch(() => {});
      idle = setTimeout(() => { void browser?.close().catch(() => {}); browser = null; }, 60_000);
      idle.unref?.();
    }
  });
  chain = job.catch((e) => log.warn('svg render failed', String(e)));
  return job;
}
