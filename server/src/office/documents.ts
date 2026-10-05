/**
 * Word documents, spreadsheets, and reading any office file back.
 *
 *  - markdownToDocx: headings, paragraphs with bold/italic/code/links, nested
 *    lists, tables, quotes, code blocks, images from the workspace, and
 *    ```chart blocks rendered as crisp PNGs.
 *  - sheetsToXlsx: styled header row, frozen + filterable, sensible column
 *    widths, number formats, formulas ("=SUM(B2:B9)"), optional totals row.
 *  - readDocument: text out of PDF, Word, PowerPoint, Excel, CSV, HTML, text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Marked, type Token, type Tokens } from 'marked';
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, ImageRun, LevelFormat, Packer, Paragraph,
  ShadingType, Table, TableCell, TableRow, TextRun, WidthType, Footer, PageNumber,
} from 'docx';
import ExcelJS from 'exceljs';
import { chartSvg, validateChart } from './charts.ts';
import { inlineImage, svgToPng } from './render.ts';
import { extractFile } from '../agents/knowledge.ts';

const run = promisify(execFile);
const ACCENT = 'C25E2C';

// ─── image sizing (PNG/JPEG headers) ─────────────────────────────────────────
function imageSize(buf: Buffer): { w: number; h: number; type: 'png' | 'jpg' | 'gif' } | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
  if (buf[0] === 0x47 && buf[1] === 0x49) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), type: 'gif' };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), type: 'jpg' };
      i += 2 + len;
    }
  }
  return null;
}
const fitWidth = (w: number, h: number, max = 560) => (w > max ? { width: max, height: Math.round((h * max) / w) } : { width: w, height: h });

// ─── Markdown → DOCX ─────────────────────────────────────────────────────────
function inlineRuns(tokens: Token[] = [], style: { bold?: boolean; italics?: boolean; code?: boolean } = {}): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  for (const t of tokens as any[]) {
    switch (t.type) {
      case 'strong': out.push(...inlineRuns(t.tokens, { ...style, bold: true })); break;
      case 'em': out.push(...inlineRuns(t.tokens, { ...style, italics: true })); break;
      case 'codespan': out.push(new TextRun({ text: decode(t.text), font: 'Consolas', size: 19, shading: { type: ShadingType.CLEAR, fill: 'F3EFE9', color: 'auto' } })); break;
      case 'link': out.push(new ExternalHyperlink({ link: t.href, children: [new TextRun({ text: decode(t.text), style: 'Hyperlink', bold: style.bold, italics: style.italics })] })); break;
      case 'br': out.push(new TextRun({ break: 1 })); break;
      case 'del': out.push(new TextRun({ text: decode(t.text), strike: true })); break;
      case 'text': if (t.tokens) out.push(...inlineRuns(t.tokens, style)); else out.push(new TextRun({ text: decode(t.text), bold: style.bold, italics: style.italics })); break;
      case 'escape': out.push(new TextRun({ text: decode(t.text) })); break;
      default: if (t.raw) out.push(new TextRun({ text: decode(t.raw.replace(/<[^>]+>/g, '')), bold: style.bold, italics: style.italics }));
    }
  }
  return out;
}
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

async function blocks(tokens: Token[], depth = 0, ordered = false): Promise<(Paragraph | Table)[]> {
  const out: (Paragraph | Table)[] = [];
  for (const t of tokens as any[]) {
    switch (t.type) {
      case 'heading': {
        const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][Math.min(3, t.depth - 1)];
        out.push(new Paragraph({ heading: level, children: inlineRuns(t.tokens) as any }));
        break;
      }
      case 'paragraph': {
        const img = t.tokens?.length === 1 && t.tokens[0].type === 'image' ? t.tokens[0] : null;
        if (img) { const p = await imageParagraph(img.href, img.text); if (p) { out.push(...p); break; } }
        out.push(new Paragraph({ children: inlineRuns(t.tokens) as any, spacing: { after: 120 } }));
        break;
      }
      case 'list':
        for (const item of t.items) {
          const first = item.tokens.find((x: any) => x.type === 'text' || x.type === 'paragraph');
          out.push(new Paragraph({ children: inlineRuns(first?.tokens ?? [{ type: 'text', text: item.text }]) as any, numbering: { reference: t.ordered ? 'numbered' : 'bullets', level: Math.min(depth, 2) } }));
          for (const sub of item.tokens.filter((x: any) => x.type === 'list')) out.push(...await blocks([sub], depth + 1, sub.ordered));
        }
        break;
      case 'blockquote':
        for (const p of t.tokens.filter((x: any) => x.type === 'paragraph')) {
          out.push(new Paragraph({ children: inlineRuns(p.tokens, { italics: true }) as any, indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: ACCENT, space: 8 } }, spacing: { before: 80, after: 120 } }));
        }
        break;
      case 'code':
        if (t.lang === 'chart') {
          try {
            const png = await svgToPng(chartSvg(validateChart(JSON.parse(t.text))), 720, 400);
            out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: 'png', data: png, transformation: { width: 560, height: 311 } })], spacing: { before: 120, after: 160 } }));
          } catch (e) { out.push(new Paragraph({ children: [new TextRun({ text: `[chart could not be drawn: ${(e as Error).message}]`, italics: true, color: '9C2B1D' })] })); }
          break;
        }
        for (const line of t.text.split('\n')) out.push(new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 18 })], shading: { type: ShadingType.CLEAR, fill: 'F3EFE9', color: 'auto' }, spacing: { after: 0 } }));
        out.push(new Paragraph({ children: [] }));
        break;
      case 'table': {
        const cell = (tokens: Token[], header: boolean) => new TableCell({
          children: [new Paragraph({ children: inlineRuns(tokens, { bold: header }) as any })],
          shading: header ? { type: ShadingType.CLEAR, fill: 'F3EFE9', color: 'auto' } : undefined,
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
        });
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ tableHeader: true, children: t.header.map((h: Tokens.TableCell) => cell(h.tokens, true)) }),
            ...t.rows.map((r: Tokens.TableCell[]) => new TableRow({ children: r.map((c) => cell(c.tokens, false)) }))],
        }));
        out.push(new Paragraph({ children: [], spacing: { after: 120 } }));
        break;
      }
      case 'hr': out.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'E6E0D6', space: 1 } } })); break;
      case 'space': break;
      default: if (t.text) out.push(new Paragraph({ children: [new TextRun(decode(String(t.text)))] }));
    }
  }
  void ordered;
  return out;
}

async function imageParagraph(href: string, alt: string): Promise<Paragraph[] | null> {
  const data = inlineImage(href);
  if (!data || data.startsWith('data:image/svg')) return null;
  const buf = Buffer.from(data.split(',')[1], 'base64');
  const size = imageSize(buf);
  if (!size) return null;
  const out = [new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: size.type, data: buf, transformation: fitWidth(size.w, size.h) })] })];
  if (alt) out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: alt, italics: true, size: 18, color: '8A8178' })], spacing: { after: 160 } }));
  return out;
}

export async function markdownToDocx(o: { title: string; subtitle?: string; author?: string; markdown: string }): Promise<Buffer> {
  const tokens = new Marked({ gfm: true }).lexer(o.markdown);
  const body = await blocks(tokens);
  const doc = new Document({
    creator: o.author ?? 'AUDA', title: o.title, description: o.subtitle,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22, color: '2A2622' }, paragraph: { spacing: { line: 300 } } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', run: { font: 'Georgia', size: 56, color: '1D1A17' }, paragraph: { spacing: { after: 120 } } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Georgia', size: 36, color: '1D1A17' }, paragraph: { spacing: { before: 360, after: 120 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 28, bold: true, color: '1D1A17' }, paragraph: { spacing: { before: 280, after: 100 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'EAD3C6', space: 2 } } } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true, color: '3A332D' }, paragraph: { spacing: { before: 200, after: 80 } } },
        { id: 'Heading4', name: 'Heading 4', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 22, bold: true, color: '5A524A' } },
      ],
      characterStyles: [{ id: 'Hyperlink', name: 'Hyperlink', run: { color: ACCENT, underline: {} } }],
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: [0, 1, 2].map((level) => ({ level, format: LevelFormat.BULLET, text: ['•', '◦', '▪'][level], alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } } })) },
        { reference: 'numbered', levels: [0, 1, 2].map((level) => ({ level, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level], text: `%${level + 1}.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 300 } } } })) },
      ],
    },
    sections: [{
      properties: { page: { margin: { top: 1200, bottom: 1200, left: 1150, right: 1150 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '9A9086' })] })] }) },
      children: [
        new Paragraph({ style: 'Title', children: [new TextRun(o.title)] }),
        ...(o.subtitle ? [new Paragraph({ children: [new TextRun({ text: o.subtitle, italics: true, size: 28, color: '5A524A', font: 'Georgia' })], spacing: { after: 240 } })] : []),
        new Paragraph({ children: [new TextRun({ text: `${o.author ?? 'Prepared by AUDA'} · ${new Date().toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' })}`, size: 18, color: '8A8178' })], spacing: { after: 360 } }),
        ...body,
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

// ─── Spreadsheets ────────────────────────────────────────────────────────────
export interface SheetSpec {
  name: string;
  columns?: { header: string; width?: number; format?: 'number' | 'integer' | 'currency' | 'percent' | 'date' | 'text' | string }[];
  rows: (string | number | boolean | null)[][] | Record<string, unknown>[];
  totals?: boolean;
}
const FORMATS: Record<string, string> = { number: '#,##0.00', integer: '#,##0', currency: '"$"#,##0.00', eur: '#,##0.00 "€"', percent: '0.0%', date: 'yyyy-mm-dd', text: '@' };

export async function sheetsToXlsx(sheets: SheetSpec[], o: { title?: string } = {}): Promise<Buffer> {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('give at least one sheet');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AUDA'; wb.title = o.title ?? ''; wb.created = new Date();
  const used = new Set<string>();
  for (const s of sheets.slice(0, 20)) {
    let name = String(s.name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet';
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${name.slice(0, 28)} ${i}`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    // Rows may be arrays or objects; objects define their own columns.
    let rows = (s.rows ?? []) as any[];
    let cols = s.columns ?? [];
    if (rows.length && !Array.isArray(rows[0])) {
      const keys = cols.length ? cols.map((c) => c.header) : [...new Set(rows.flatMap((r) => Object.keys(r)))];
      if (!cols.length) cols = keys.map((k) => ({ header: k }));
      rows = rows.map((r) => keys.map((k) => r[k] ?? null));
    }
    if (!cols.length) cols = (rows[0] ?? []).map((_: unknown, i: number) => ({ header: `Column ${i + 1}` }));
    ws.addRow(cols.map((c) => c.header));
    for (const r of rows.slice(0, 100_000)) {
      ws.addRow((r as any[]).map((v) => (typeof v === 'string' && v.startsWith('=') ? { formula: v.slice(1) } : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v) : v)));
    }
    if (s.totals && rows.length) {
      const last = rows.length + 1;
      const total = ws.addRow(cols.map((c, i) => {
        if (i === 0) return 'Total';
        const numeric = rows.some((r: any) => typeof r[i] === 'number' || (typeof r[i] === 'string' && r[i].startsWith('='))) && !['text', 'date', 'percent'].includes(c.format ?? '');
        const L = ws.getColumn(i + 1).letter;
        return numeric ? { formula: `SUM(${L}2:${L}${last})` } : null;
      }));
      total.font = { bold: true };
      total.eachCell((c) => { c.border = { top: { style: 'thin', color: { argb: 'FF' + ACCENT } } }; });
    }
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + ACCENT } };
    head.alignment = { vertical: 'middle' };
    head.height = 22;
    cols.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      const fmt = c.format ? FORMATS[c.format] ?? c.format : undefined;
      if (fmt) col.eachCell((cell, n) => { if (n > 1) cell.numFmt = fmt; });
      const longest = Math.max(String(c.header).length, ...rows.slice(0, 500).map((r: any) => String(r[i] ?? '').length));
      col.width = c.width ?? Math.min(60, Math.max(10, longest + 2));
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, cols.length) } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ─── Reading documents ───────────────────────────────────────────────────────
export async function readDocument(abs: string, maxChars = 200_000): Promise<{ text: string; kind: string; pages?: number }> {
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(abs);
    const parts: string[] = [];
    wb.eachSheet((ws) => {
      parts.push(`## Sheet: ${ws.name} (${ws.rowCount} rows)`);
      ws.eachRow({ includeEmpty: false }, (row, n) => {
        if (n > 2000) return;
        const vals = (row.values as any[]).slice(1).map((v) => (v && typeof v === 'object' ? (v instanceof Date ? v.toISOString().slice(0, 10) : 'formula' in v ? `=${v.formula}${v.result !== undefined ? ` (${v.result})` : ''}` : 'result' in v ? v.result : 'text' in v ? v.text : 'richText' in v ? v.richText.map((r: any) => r.text).join('') : JSON.stringify(v)) : v ?? ''));
        parts.push(vals.join('\t'));
      });
    });
    return { text: parts.join('\n').slice(0, maxChars), kind: 'spreadsheet' };
  }
  if (ext === '.pptx') {
    const list = (await run('unzip', ['-Z1', abs], { maxBuffer: 8 << 20 })).stdout.split('\n').filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
    const parts: string[] = [];
    for (const [i, f] of list.entries()) {
      const xml = (await run('unzip', ['-p', abs, f], { maxBuffer: 16 << 20 })).stdout;
      const text = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ').replace(/\s+/g, ' ').trim();
      parts.push(`## Slide ${i + 1}\n${text}`);
    }
    return { text: parts.join('\n\n').slice(0, maxChars), kind: 'presentation', pages: list.length };
  }
  if (ext === '.pdf') {
    const text = await extractFile(abs);
    let pages: number | undefined;
    try { pages = Number(/Pages:\s+(\d+)/.exec((await run('pdfinfo', [abs], { timeout: 20_000 })).stdout)?.[1]) || undefined; } catch { /* pdfinfo optional */ }
    return { text: text.slice(0, maxChars), kind: 'pdf', pages };
  }
  const text = await extractFile(abs);
  return { text: text.slice(0, maxChars), kind: ext.slice(1) || 'text' };
}

export const fileSize = (abs: string) => { try { return fs.statSync(abs).size; } catch { return 0; } };
