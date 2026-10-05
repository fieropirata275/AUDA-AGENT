/**
 * Presentations from one deck spec, three ways:
 *  - .pptx  — editable PowerPoint with native charts, tables and speaker notes;
 *  - .html  — a self-contained deck (arrow keys / click / swipe, presenter-free);
 *  - .pdf   — 16:9, one slide per page, for sending.
 *
 * Layouts: title, section, bullets, two-column, chart, image, quote, table,
 * stats, closing. Themes: auda (warm light), midnight (dark), paper (minimal).
 */
import PptxGenJS from 'pptxgenjs';
import { chartSvg, validateChart, PALETTE, type ChartSpec } from './charts.ts';
import { fontFaces, htmlToPdf, inlineImage } from './render.ts';

export type Layout = 'title' | 'section' | 'bullets' | 'two-column' | 'chart' | 'image' | 'quote' | 'table' | 'stats' | 'closing';
export interface Slide {
  layout?: Layout; title?: string; subtitle?: string; bullets?: string[];
  left?: { heading?: string; bullets?: string[] }; right?: { heading?: string; bullets?: string[] };
  chart?: ChartSpec; image?: string; caption?: string; quote?: string; by?: string;
  table?: { headers: string[]; rows: (string | number)[][] }; stats?: { value: string; label: string }[]; notes?: string;
}
export interface Deck { title: string; subtitle?: string; author?: string; theme?: 'auda' | 'midnight' | 'paper'; slides: Slide[] }

const THEMES = {
  auda: { bg: 'F7F3EC', surface: 'FFFFFF', ink: '1F1B17', muted: '7A7067', accent: 'C25E2C', line: 'E6DED2', titleFont: 'Georgia', bodyFont: 'Calibri' },
  midnight: { bg: '15130F', surface: '211E19', ink: 'F4EEE6', muted: 'A39A90', accent: 'F08F58', line: '332E28', titleFont: 'Georgia', bodyFont: 'Calibri' },
  paper: { bg: 'FFFFFF', surface: 'F6F6F4', ink: '111111', muted: '6B6B6B', accent: '2F5BD3', line: 'E4E4E0', titleFont: 'Calibri', bodyFont: 'Calibri' },
};
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function validateDeck(d: any): Deck {
  if (!d || typeof d !== 'object') throw new Error('deck must be an object');
  const slides = (Array.isArray(d.slides) ? d.slides : []).slice(0, 60).map((s: any) => {
    const out: Slide = { ...s, layout: s.layout ?? (s.chart ? 'chart' : s.table ? 'table' : s.stats ? 'stats' : s.quote ? 'quote' : s.image ? 'image' : s.left || s.right ? 'two-column' : 'bullets') };
    if (out.chart) out.chart = validateChart(out.chart);
    if (out.bullets && !Array.isArray(out.bullets)) out.bullets = [String(out.bullets)];
    return out;
  });
  if (!slides.length) throw new Error('a deck needs at least one slide');
  return { title: String(d.title ?? 'Presentation'), subtitle: d.subtitle, author: d.author, theme: (['auda', 'midnight', 'paper'].includes(d.theme) ? d.theme : 'auda'), slides };
}

/** "  - sub point" (two-space or tab indent) becomes a nested bullet. */
const bulletLevel = (b: string) => { const m = /^(\s*)/.exec(b)![1].replace(/\t/g, '  ').length; return { level: Math.min(2, Math.floor(m / 2)), text: b.trim().replace(/^[-•*]\s*/, '') }; };

// ─── PowerPoint ──────────────────────────────────────────────────────────────
export async function deckToPptx(deck: Deck): Promise<Buffer> {
  const t = THEMES[deck.theme ?? 'auda'];
  // pptxgenjs is CommonJS: depending on the loader the class is the default export or its .default.
  const Ctor: any = (PptxGenJS as any).default ?? PptxGenJS;
  const pptx: InstanceType<typeof import('pptxgenjs').default> = new Ctor();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 × 7.5 in
  pptx.title = deck.title; pptx.author = deck.author ?? 'AUDA'; pptx.company = 'AUDA';
  const W = 13.33, H = 7.5, M = 0.7;
  const titleOpts = (y = 0.55, size = 30) => ({ x: M, y, w: W - 2 * M, h: 0.9, fontFace: t.titleFont, fontSize: size, color: t.ink, bold: false, valign: 'top' as const });
  const bullets = (items: string[] = [], box: { x: number; y: number; w: number; h: number }, size = 20) => items.map(bulletLevel).map((b, i, a) => ({
    text: b.text, options: { bullet: b.level ? { indent: 18 } : { code: '25CF', indent: 22 }, indentLevel: b.level, fontSize: size - b.level * 3, color: b.level ? t.muted : t.ink, breakLine: i < a.length - 1, paraSpaceAfter: 8 },
  }));
  const chartType = (c: ChartSpec) => ({ bar: pptx.ChartType.bar, hbar: pptx.ChartType.bar, line: pptx.ChartType.line, area: pptx.ChartType.area, pie: pptx.ChartType.pie, donut: pptx.ChartType.doughnut }[c.type]);

  deck.slides.forEach((s, idx) => {
    const sl = pptx.addSlide();
    sl.background = { color: s.layout === 'section' || s.layout === 'closing' ? t.accent : t.bg };
    const onAccent = s.layout === 'section' || s.layout === 'closing';
    if (!onAccent && s.layout !== 'title') {
      sl.addShape(pptx.ShapeType.rect, { x: M, y: 0.42, w: 0.6, h: 0.06, fill: { color: t.accent }, line: { color: t.accent } });
      sl.addText(`${idx + 1}`, { x: W - M - 1, y: H - 0.5, w: 1, h: 0.3, align: 'right', fontSize: 10, color: t.muted, fontFace: t.bodyFont });
    }
    switch (s.layout) {
      case 'title':
        sl.addShape(pptx.ShapeType.ellipse, { x: M, y: 1.2, w: 0.9, h: 0.9, fill: { color: t.accent }, line: { color: t.accent } });
        sl.addText(s.title ?? deck.title, { ...titleOpts(3.0, 46), h: 1.6 });
        if (s.subtitle ?? deck.subtitle) sl.addText(String(s.subtitle ?? deck.subtitle), { x: M, y: 4.6, w: W - 2 * M, h: 0.8, fontSize: 22, color: t.muted, fontFace: t.titleFont, italic: true });
        sl.addText(deck.author ?? 'Prepared by AUDA', { x: M, y: H - 1, w: 6, h: 0.4, fontSize: 12, color: t.muted, fontFace: t.bodyFont });
        break;
      case 'section':
      case 'closing':
        sl.addText(s.title ?? (s.layout === 'closing' ? 'Thank you' : ''), { x: M, y: 2.6, w: W - 2 * M, h: 1.4, fontSize: 44, color: 'FFFFFF', fontFace: t.titleFont });
        if (s.subtitle) sl.addText(s.subtitle, { x: M, y: 4.1, w: W - 2 * M, h: 0.8, fontSize: 20, color: 'FFFFFF', fontFace: t.bodyFont, transparency: 15 });
        break;
      case 'two-column': {
        sl.addText(s.title ?? '', titleOpts());
        const colW = (W - 2 * M - 0.5) / 2;
        [s.left, s.right].forEach((col, k) => {
          const x = M + k * (colW + 0.5);
          sl.addShape(pptx.ShapeType.roundRect, { x, y: 1.7, w: colW, h: 5, fill: { color: t.surface }, line: { color: t.line }, rectRadius: 0.12 });
          if (col?.heading) sl.addText(col.heading, { x: x + 0.3, y: 1.9, w: colW - 0.6, h: 0.5, fontSize: 18, bold: true, color: t.accent, fontFace: t.bodyFont });
          sl.addText(bullets(col?.bullets, { x: 0, y: 0, w: 0, h: 0 }, 17), { x: x + 0.3, y: 2.5, w: colW - 0.6, h: 4, valign: 'top', fontFace: t.bodyFont });
        });
        break;
      }
      case 'chart': {
        sl.addText(s.title ?? s.chart?.title ?? '', titleOpts());
        const c = s.chart!;
        const pie = c.type === 'pie' || c.type === 'donut';
        sl.addChart(chartType(c) as any, pie ? [{ name: c.series[0].name, labels: c.labels, values: c.series[0].values }] : c.series.map((x) => ({ name: x.name, labels: c.labels, values: x.values })), {
          x: M, y: 1.6, w: W - 2 * M, h: s.caption ? 4.9 : 5.3, barDir: c.type === 'hbar' ? 'bar' : 'col', barGrouping: c.stacked ? 'stacked' : 'clustered',
          chartColors: PALETTE.map((p) => p.slice(1)), showLegend: c.series.length > 1 || pie, legendPos: 'b', legendColor: t.ink, legendFontSize: 12,
          catAxisLabelColor: t.muted, valAxisLabelColor: t.muted, catAxisLabelFontSize: 12, valAxisLabelFontSize: 11, valGridLine: { color: t.line, size: 0.75 },
          showValue: !pie && c.series.length === 1 && c.labels.length <= 12, dataLabelColor: t.ink, dataLabelFontSize: 11, showPercent: pie, holeSize: 55,
          lineSize: 3, lineDataSymbolSize: 7,
        } as any);
        if (s.caption) sl.addText(s.caption, { x: M, y: 6.6, w: W - 2 * M, h: 0.4, fontSize: 12, color: t.muted, fontFace: t.bodyFont });
        break;
      }
      case 'image': {
        sl.addText(s.title ?? '', titleOpts());
        const data = s.image ? inlineImage(s.image) : null;
        if (data) sl.addImage({ data: data.slice(5), x: M, y: 1.6, w: W - 2 * M, h: 4.9, sizing: { type: 'contain', w: W - 2 * M, h: 4.9 } });
        else sl.addText(`[image not found: ${s.image ?? ''}]`, { x: M, y: 3, w: W - 2 * M, h: 1, color: t.muted, align: 'center' });
        if (s.caption) sl.addText(s.caption, { x: M, y: 6.6, w: W - 2 * M, h: 0.4, fontSize: 12, color: t.muted, align: 'center', fontFace: t.bodyFont });
        break;
      }
      case 'quote':
        sl.addText(`“${s.quote ?? ''}”`, { x: M + 0.6, y: 1.6, w: W - 2 * M - 1.2, h: 3.6, fontSize: 34, fontFace: t.titleFont, italic: true, color: t.ink, valign: 'middle' });
        if (s.by) sl.addText(`— ${s.by}`, { x: M + 0.6, y: 5.3, w: W - 2 * M - 1.2, h: 0.6, fontSize: 16, color: t.accent, fontFace: t.bodyFont });
        break;
      case 'table': {
        sl.addText(s.title ?? '', titleOpts());
        const tb = s.table!;
        const rows = [tb.headers.map((h) => ({ text: String(h), options: { bold: true, color: 'FFFFFF', fill: { color: t.accent } } })),
          ...tb.rows.slice(0, 14).map((r, i) => r.map((c) => ({ text: String(c ?? ''), options: { color: t.ink, fill: { color: i % 2 ? t.surface : t.bg } } })))];
        sl.addTable(rows as any, { x: M, y: 1.6, w: W - 2 * M, fontSize: 13, fontFace: t.bodyFont, border: { type: 'solid', color: t.line, pt: 0.75 }, autoPage: false, rowH: 0.42 });
        break;
      }
      case 'stats': {
        sl.addText(s.title ?? '', titleOpts());
        const st = (s.stats ?? []).slice(0, 4);
        const w = (W - 2 * M - 0.4 * (st.length - 1)) / Math.max(1, st.length);
        st.forEach((x, k) => {
          const xx = M + k * (w + 0.4);
          sl.addShape(pptx.ShapeType.roundRect, { x: xx, y: 2.2, w, h: 3, fill: { color: t.surface }, line: { color: t.line }, rectRadius: 0.12 });
          sl.addText(String(x.value), { x: xx, y: 2.6, w, h: 1.4, align: 'center', fontSize: 48, color: t.accent, fontFace: t.titleFont });
          sl.addText(String(x.label), { x: xx + 0.2, y: 4.1, w: w - 0.4, h: 0.9, align: 'center', fontSize: 15, color: t.muted, fontFace: t.bodyFont });
        });
        break;
      }
      default:
        sl.addText(s.title ?? '', titleOpts());
        if (s.subtitle) sl.addText(s.subtitle, { x: M, y: 1.35, w: W - 2 * M, h: 0.5, fontSize: 16, color: t.muted, fontFace: t.bodyFont });
        sl.addText(bullets(s.bullets, { x: 0, y: 0, w: 0, h: 0 }), { x: M, y: s.subtitle ? 2.0 : 1.7, w: W - 2 * M, h: 5, valign: 'top', fontFace: t.bodyFont });
    }
    if (s.notes) sl.addNotes(s.notes);
  });
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }) as ArrayBuffer);
}

// ─── HTML deck (and its PDF) ─────────────────────────────────────────────────
function slideHtml(s: Slide, i: number, deck: Deck) {
  const t = THEMES[deck.theme ?? 'auda'];
  const list = (items: string[] = []) => `<ul>${items.map(bulletLevel).map((b) => `<li class="l${b.level}">${esc(b.text)}</li>`).join('')}</ul>`;
  const num = s.layout === 'title' || s.layout === 'section' || s.layout === 'closing' ? '' : `<div class="num">${i + 1}</div>`;
  const head = (x?: string) => `<div class="bar"></div><h2>${esc(x ?? '')}</h2>`;
  let body: string;
  switch (s.layout) {
    case 'title': body = `<div class="orb"></div><h1>${esc(s.title ?? deck.title)}</h1>${s.subtitle ?? deck.subtitle ? `<p class="sub">${esc(s.subtitle ?? deck.subtitle)}</p>` : ''}<p class="by">${esc(deck.author ?? 'Prepared by AUDA')}</p>`; break;
    case 'section': case 'closing': body = `<h1>${esc(s.title ?? (s.layout === 'closing' ? 'Thank you' : ''))}</h1>${s.subtitle ? `<p class="sub">${esc(s.subtitle)}</p>` : ''}`; break;
    case 'two-column': body = `${head(s.title)}<div class="cols">${[s.left, s.right].map((c) => `<div class="card">${c?.heading ? `<h3>${esc(c.heading)}</h3>` : ''}${list(c?.bullets)}</div>`).join('')}</div>`; break;
    case 'chart': body = `${head(s.title ?? s.chart?.title)}<div class="chart">${chartSvg({ ...s.chart!, title: undefined }, { width: 1100, height: s.caption ? 470 : 500, ink: `#${t.ink}`, muted: `#${t.muted}`, grid: `#${t.line}`, font: "'AUDA Sans',system-ui,sans-serif" })}</div>${s.caption ? `<p class="cap">${esc(s.caption)}</p>` : ''}`; break;
    case 'image': { const src = s.image ? inlineImage(s.image) : null; body = `${head(s.title)}<div class="img">${src ? `<img src="${src}" alt="">` : `<p class="cap">[image not found: ${esc(s.image)}]</p>`}</div>${s.caption ? `<p class="cap">${esc(s.caption)}</p>` : ''}`; break; }
    case 'quote': body = `<blockquote>“${esc(s.quote)}”</blockquote>${s.by ? `<p class="who">— ${esc(s.by)}</p>` : ''}`; break;
    case 'table': body = `${head(s.title)}<table><thead><tr>${s.table!.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${s.table!.rows.slice(0, 14).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`; break;
    case 'stats': body = `${head(s.title)}<div class="stats">${(s.stats ?? []).slice(0, 4).map((x) => `<div class="card stat"><b>${esc(x.value)}</b><span>${esc(x.label)}</span></div>`).join('')}</div>`; break;
    default: body = `${head(s.title)}${s.subtitle ? `<p class="lead">${esc(s.subtitle)}</p>` : ''}${list(s.bullets)}`;
  }
  return `<section class="slide l-${s.layout}">${body}${num}${s.notes ? `<aside class="notes">${esc(s.notes)}</aside>` : ''}</section>`;
}

export function deckToHtml(deck: Deck, o: { print?: boolean } = {}) {
  const t = THEMES[deck.theme ?? 'auda'];
  const css = `${fontFaces()}
  :root { --bg:#${t.bg}; --surface:#${t.surface}; --ink:#${t.ink}; --muted:#${t.muted}; --accent:#${t.accent}; --line:#${t.line}; }
  * { box-sizing: border-box; } html, body { margin: 0; background: ${o.print ? 'var(--bg)' : '#0d0b09'}; }
  body { font-family: 'AUDA Sans', system-ui, sans-serif; color: var(--ink); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .slide { width: 1280px; height: 720px; position: relative; overflow: hidden; background: var(--bg); padding: 56px 68px; display: flex; flex-direction: column; }
  .slide h1 { font: 400 76px/1.05 'AUDA Serif', Georgia, serif; margin: 0; letter-spacing: -0.01em; }
  .slide h2 { font: 400 44px/1.1 'AUDA Serif', Georgia, serif; margin: 10px 0 22px; }
  .slide h3 { margin: 0 0 10px; color: var(--accent); font-size: 24px; }
  .bar { width: 56px; height: 6px; border-radius: 3px; background: var(--accent); }
  .num { position: absolute; right: 56px; bottom: 32px; font-size: 14px; color: var(--muted); }
  ul { margin: 0; padding-left: 30px; font-size: 28px; line-height: 1.45; } li { margin: 6px 0; } li::marker { color: var(--accent); }
  li.l1 { margin-left: 30px; font-size: 23px; color: var(--muted); } li.l2 { margin-left: 60px; font-size: 20px; color: var(--muted); }
  .lead, .sub { font: italic 400 30px/1.35 'AUDA Serif', Georgia, serif; color: var(--muted); margin: 0 0 18px; }
  .l-title { justify-content: flex-end; padding-bottom: 80px; } .l-title .orb { position: absolute; top: 70px; left: 68px; width: 86px; height: 86px; border-radius: 50%; background: radial-gradient(circle at 36% 30%, #f6b183, var(--accent) 55%, #6d2d10); box-shadow: 0 14px 40px rgba(0,0,0,.18); }
  .l-title .sub { margin-top: 18px; } .l-title .by { color: var(--muted); font-size: 18px; margin: 34px 0 0; }
  .l-section, .l-closing { background: var(--accent); color: #fff; justify-content: center; } .l-section .sub, .l-closing .sub { color: rgba(255,255,255,.85); font-style: normal; font-family: 'AUDA Sans'; font-size: 26px; margin-top: 16px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; flex: 1; } .card { background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: 26px 28px; } .cols ul { font-size: 24px; }
  .chart { flex: 1; display: grid; place-items: center; } .chart svg { width: 100%; height: auto; max-height: 520px; }
  .cap { color: var(--muted); font-size: 18px; margin: 10px 0 0; text-align: center; }
  .img { flex: 1; display: grid; place-items: center; min-height: 0; } .img img { max-width: 100%; max-height: 500px; border-radius: 14px; }
  .l-quote { justify-content: center; padding: 80px 120px; } blockquote { margin: 0; font: italic 400 52px/1.25 'AUDA Serif', Georgia, serif; } .who { color: var(--accent); font-size: 22px; margin-top: 26px; }
  table { width: 100%; border-collapse: collapse; font-size: 20px; } th { background: var(--accent); color: #fff; text-align: left; padding: 10px 14px; } td { padding: 9px 14px; border-bottom: 1px solid var(--line); } tbody tr:nth-child(even) td { background: var(--surface); }
  .stats { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 24px; flex: 1; align-items: center; } .stat { text-align: center; padding: 46px 20px; } .stat b { display: block; font: 400 84px/1 'AUDA Serif', Georgia, serif; color: var(--accent); } .stat span { display: block; margin-top: 16px; font-size: 22px; color: var(--muted); }
  .notes { display: none; }
  ${o.print ? `@page { size: 1280px 720px; margin: 0; } .slide { break-after: page; }` : `
  .deck { position: fixed; inset: 0; display: grid; place-items: center; }
  .deck .slide { position: absolute; transform-origin: center; transition: opacity .35s ease, transform .45s cubic-bezier(.2,.8,.2,1); opacity: 0; pointer-events: none; }
  .deck .slide.on { opacity: 1; pointer-events: auto; }
  .hud { position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); color: #fff9; font: 13px system-ui; display: flex; gap: 14px; align-items: center; }
  .hud button { background: #ffffff1a; border: 0; color: #fff; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
  .progress { position: fixed; top: 0; left: 0; height: 3px; background: #${t.accent}; transition: width .3s; }`}`;
  const slides = deck.slides.map((s, i) => slideHtml(s, i, deck)).join('\n');
  if (o.print) return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(deck.title)}</title><style>${css}</style></head><body>${slides}</body></html>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(deck.title)}</title><style>${css}</style></head><body>
<div class="progress" id="p"></div><div class="deck" id="d">${slides}</div>
<div class="hud"><button id="prev" aria-label="Previous">‹</button><span id="n"></span><button id="next" aria-label="Next">›</button><button id="fs">Fullscreen</button></div>
<script>(function(){var s=[].slice.call(document.querySelectorAll('.deck .slide')),i=Math.max(0,Math.min(s.length-1,(parseInt(location.hash.slice(1))||1)-1));
function fit(){var k=Math.min(innerWidth/1280,(innerHeight-40)/720);s.forEach(function(e,j){e.style.transform='scale('+k+') translateX('+(j<i?-40:j>i?40:0)+'px)';});}
function go(n){i=Math.max(0,Math.min(s.length-1,n));s.forEach(function(e,j){e.classList.toggle('on',j===i);});document.getElementById('n').textContent=(i+1)+' / '+s.length;document.getElementById('p').style.width=((i+1)/s.length*100)+'%';history.replaceState(null,'','#'+(i+1));fit();}
addEventListener('keydown',function(e){if(['ArrowRight','PageDown',' '].indexOf(e.key)>=0){e.preventDefault();go(i+1);}if(['ArrowLeft','PageUp'].indexOf(e.key)>=0){e.preventDefault();go(i-1);}if(e.key==='Home')go(0);if(e.key==='End')go(s.length-1);if(e.key==='f')document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen();});
var x0=null;addEventListener('touchstart',function(e){x0=e.touches[0].clientX;});addEventListener('touchend',function(e){if(x0===null)return;var dx=e.changedTouches[0].clientX-x0;if(Math.abs(dx)>40)go(i+(dx<0?1:-1));x0=null;});
document.getElementById('prev').onclick=function(){go(i-1)};document.getElementById('next').onclick=function(){go(i+1)};document.getElementById('fs').onclick=function(){document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen()};
addEventListener('resize',fit);go(i);})();</script></body></html>`;
}

export async function deckToPdf(deck: Deck): Promise<Buffer> {
  return htmlToPdf(deckToHtml(deck, { print: true }), { width: '1280px', height: '720px', footer: false });
}
