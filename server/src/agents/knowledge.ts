/**
 * Knowledge base for custom agents.
 *
 * Documents (uploads, web pages, notes, and lessons the agent writes itself)
 * are split into overlapping passages and indexed twice: full-text (SQLite
 * FTS5, BM25) and as vectors. Vectors come from a local embedding model in LM
 * Studio when one is configured, otherwise from a deterministic hashed
 * bag-of-words embedding that needs no model at all — retrieval always works,
 * offline included.
 *
 * Ranking is learned: each candidate passage gets a small feature vector
 * (BM25, cosine, past usefulness, kind, confidence, freshness) and a per-agent
 * logistic-regression re-ranker scores it. Every retrieval is logged with its
 * features; when the task ends the log is labelled (was the passage actually
 * used? did the person rate the result well?) and the ranker takes an online
 * gradient step. See learning.ts.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getSetting, insert, json, now, q, tx, uid, update } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { log } from '../core/log.ts';
import { modelSettings } from '../models/router.ts';
import { resolveSecret } from '../secrets/broker.ts';
import { Permanent } from '../tools/errors.ts';

const run = promisify(execFile);
export const CHUNK = 1200;
export const OVERLAP = 150;
export const DIMS = 384;
export const HASHED = 'hashed-384';
const MAX_DOC_CHARS = 2_000_000;

// ─── text extraction ─────────────────────────────────────────────────────────

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.log', '.ini', '.toml', '.sql', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.cs', '.rb', '.php', '.sh', '.css', '.scss', '.env.example', '.rst', '.tex']);

export function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
}

/** Extract readable text from a file on disk. PDFs need `pdftotext`; .docx uses `unzip`. */
export async function extractFile(abs: string): Promise<string> {
  const ext = path.extname(abs).toLowerCase();
  const stat = fs.statSync(abs);
  if (stat.size > 80 * 1024 * 1024) throw new Permanent('File is larger than 80 MB');
  if (ext === '.pdf') {
    try { return (await run('pdftotext', ['-layout', '-q', abs, '-'], { maxBuffer: 64 << 20, timeout: 120_000 })).stdout; }
    catch (e: any) { throw new Permanent(e.code === 'ENOENT' ? 'Reading PDFs needs pdftotext (poppler-utils) on AUDA’s computer' : `Couldn't read the PDF: ${e.message}`); }
  }
  if (ext === '.docx' || ext === '.pptx' || ext === '.odt') {
    const inner = ext === '.docx' ? 'word/document.xml' : ext === '.odt' ? 'content.xml' : 'ppt/slides/*.xml';
    try { return htmlToText((await run('unzip', ['-p', abs, inner], { maxBuffer: 64 << 20, timeout: 60_000 })).stdout.replace(/<\/(w:p|a:p|text:p)>/g, '\n')); }
    catch (e: any) { throw new Permanent(e.code === 'ENOENT' ? 'Reading Office files needs unzip on AUDA’s computer' : `Couldn't read the document: ${e.message}`); }
  }
  const buf = fs.readFileSync(abs);
  if (ext === '.html' || ext === '.htm') return htmlToText(buf.toString('utf8'));
  if (TEXT_EXT.has(ext) || isProbablyText(buf)) return buf.toString('utf8');
  throw new Permanent(`Can't read ${ext || 'this kind of'} files yet — upload text, Markdown, CSV, HTML, PDF or Word documents`);
}
function isProbablyText(buf: Buffer) {
  const n = Math.min(buf.length, 4096);
  let bad = 0;
  for (let i = 0; i < n; i++) { const c = buf[i]; if (c === 0) return false; if (c < 9 || (c > 13 && c < 32)) bad++; }
  return bad / Math.max(1, n) < 0.02;
}

// ─── chunking ────────────────────────────────────────────────────────────────

/** Split on paragraph/sentence boundaries into ~CHUNK-character passages with overlap. */
export function chunkText(text: string, size = CHUNK, overlap = OVERLAP): string[] {
  const clean = text.replace(/\r/g, '').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const win = clean.slice(start + Math.floor(size * 0.5), end);
      const cut = Math.max(win.lastIndexOf('\n\n'), win.lastIndexOf('. '), win.lastIndexOf('\n'));
      if (cut > 0) end = start + Math.floor(size * 0.5) + cut + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

// ─── embeddings ──────────────────────────────────────────────────────────────

const STOP = new Set('a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those i you he she we they them his her our your their not no do does did so such can will would should could may might must have has had there here what which who whom when where why how all any each more most other some than too very just also into over under about after before between out up down off again further once only own same both few nor de la el los las y o en un una que por para con del al se es'.split(' '));
export function tokens(s: string): string[] {
  return (s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9][a-z0-9_.+#-]*[a-z0-9+#]|[a-z0-9]/g) ?? [])
    .filter((t) => t.length > 1 && !STOP.has(t));
}
function fnv(s: string) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

/** Deterministic hashed TF embedding (unigrams + bigrams, signed feature hashing, log-tf, L2-normalised). */
export function hashedEmbedding(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  const t = tokens(text);
  const counts = new Map<string, number>();
  for (let i = 0; i < t.length; i++) {
    counts.set(t[i], (counts.get(t[i]) ?? 0) + 1);
    if (i + 1 < t.length) counts.set(`${t[i]} ${t[i + 1]}`, (counts.get(`${t[i]} ${t[i + 1]}`) ?? 0) + 0.5);
  }
  for (const [term, c] of counts) { const h = fnv(term); v[h % DIMS] += (h & 0x80000000 ? -1 : 1) * (1 + Math.log(c)); }
  return normalise(v);
}
function normalise(v: Float32Array) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < v.length; i++) v[i] /= n; return v; }
export function cosine(a: Float32Array, b: Float32Array) { if (a.length !== b.length) return 0; let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: any): Float32Array | null => {
  if (!b) return null;
  const u8 = b instanceof Uint8Array ? b : Buffer.from(b);
  return new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
};

/** The configured embedder: a local model in LM Studio, or the built-in hashed one. */
export function embedder(): string {
  const m = getSetting<string>('kb.embedModel', '');
  return m && modelSettings().local?.baseUrl ? `local:${m}` : HASHED;
}

const embedFailures = { n: 0, until: 0 };
/** Embed texts with `name`; falls back to hashed (and says so) when the local model is unavailable. */
export async function embed(texts: string[], name = embedder()): Promise<{ name: string; vectors: Float32Array[] }> {
  if (name === HASHED || embedFailures.until > Date.now()) return { name: HASHED, vectors: texts.map(hashedEmbedding) };
  const local = modelSettings().local!;
  try {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 32) {
      const r = await fetch(`${local.baseUrl.replace(/\/+$/, '')}/v1/embeddings`, {
        method: 'POST', signal: AbortSignal.timeout(60_000),
        headers: { 'content-type': 'application/json', ...(local.apiKeySecret ? { authorization: `Bearer ${resolveSecret(local.apiKeySecret)}` } : {}) },
        body: JSON.stringify({ model: name.slice(6), input: texts.slice(i, i + 32).map((t) => t.slice(0, 8000)) }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j: any = await r.json();
      for (const d of j.data ?? []) out.push(normalise(Float32Array.from(d.embedding)));
    }
    if (out.length !== texts.length) throw new Error('embedding count mismatch');
    embedFailures.n = 0;
    return { name, vectors: out };
  } catch (e) {
    if (++embedFailures.n >= 3) embedFailures.until = Date.now() + 5 * 60_000;
    log.warn('local embeddings failed; using hashed embeddings', String(e));
    return { name: HASHED, vectors: texts.map(hashedEmbedding) };
  }
}

// ─── documents ───────────────────────────────────────────────────────────────

export interface AddDoc { agentId: string; title: string; text: string; source: 'upload' | 'url' | 'note' | 'lesson' | 'skill' | 'task'; sourceRef?: string; kind?: 'doc' | 'lesson' | 'skill'; confidence?: number; replaceId?: string }

/** Add (or replace) a document: chunk, embed and index it atomically. */
export async function addDocument(d: AddDoc): Promise<string> {
  const text = d.text.slice(0, MAX_DOC_CHARS);
  const pieces = chunkText(text);
  if (!pieces.length) throw new Permanent(`“${d.title}” has no readable text`);
  const { name, vectors } = await embed(pieces);
  const id = d.replaceId ?? uid('kbd');
  tx(() => {
    if (d.replaceId) dropChunks(d.replaceId);
    const exists = d.replaceId && q.get('SELECT id FROM kb_documents WHERE id = ?', d.replaceId);
    if (exists) update('kb_documents', id, { title: d.title.slice(0, 200), chars: text.length, state: 'ready', error: null, updated_at: now() });
    else insert('kb_documents', { id, agent_id: d.agentId, title: d.title.slice(0, 200), source: d.source, source_ref: d.sourceRef ?? null, kind: d.kind ?? 'doc', chars: text.length, confidence: d.confidence ?? 1, state: 'ready', created_at: now(), updated_at: now() });
    pieces.forEach((p, i) => {
      const cid = uid('kbc');
      insert('kb_chunks', { id: cid, doc_id: id, agent_id: d.agentId, idx: i, text: p, vector: toBlob(vectors[i]), embedder: name });
      q.run('INSERT INTO kb_fts (chunk_id, agent_id, text) VALUES (?, ?, ?)', cid, d.agentId, `${d.title}\n${p}`);
    });
  });
  changed('knowledge', id);
  changed('agent', d.agentId);
  return id;
}

function dropChunks(docId: string) {
  q.run('DELETE FROM kb_fts WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE doc_id = ?)', docId);
  q.run('DELETE FROM kb_chunks WHERE doc_id = ?', docId);
}
export function removeDocument(docId: string) {
  const d = q.get('SELECT agent_id FROM kb_documents WHERE id = ?', docId);
  tx(() => { dropChunks(docId); q.run('DELETE FROM kb_documents WHERE id = ?', docId); });
  changed('knowledge', docId, true);
  if (d) changed('agent', d.agent_id);
}
export function documents(agentId: string) {
  return q.all('SELECT d.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.doc_id = d.id) passages FROM kb_documents d WHERE agent_id = ? ORDER BY kind, updated_at DESC', agentId)
    .map((d) => ({ id: d.id, title: d.title, source: d.source, sourceRef: d.source_ref, kind: d.kind, chars: d.chars, passages: d.passages, confidence: Math.round(d.confidence * 100) / 100, uses: d.uses, helpful: d.helpful, state: d.state, error: d.error, createdAt: d.created_at, updatedAt: d.updated_at }));
}

export async function fetchUrlText(url: string): Promise<{ title: string; text: string; hash: string }> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Permanent('That is not a valid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Permanent('Only http(s) URLs can be learned from');
  const r = await fetch(u, { headers: { 'user-agent': 'AUDA-Agent (knowledge)', accept: 'text/html,text/plain,application/json,*/*' }, signal: AbortSignal.timeout(30_000), redirect: 'follow' });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} from ${u.host}`), { status: r.status });
  const ct = r.headers.get('content-type') ?? '';
  const raw = (await r.text()).slice(0, MAX_DOC_CHARS * 2);
  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(raw)?.[1]?.trim() || u.host + u.pathname;
  const text = ct.includes('html') || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw;
  return { title, text, hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 24) };
}

// ─── retrieval ───────────────────────────────────────────────────────────────

export const FEATURES = ['bm25', 'cosine', 'useful', 'lesson', 'confidence', 'fresh'] as const;
export interface Ranker { w: number[]; b: number; n: number }
export const DEFAULT_RANKER: Ranker = { w: [2.2, 2.6, 0.8, 0.4, 0.6, 0.2], b: -2.2, n: 0 };
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export const score = (r: Ranker, f: number[]) => sigmoid(r.b + f.reduce((s, x, i) => s + x * (r.w[i] ?? 0), 0));

export interface Hit { chunkId: string; docId: string; title: string; kind: string; text: string; score: number; features: number[] }

/** Build an FTS5 query from free text: OR of the distinctive terms, quoted. */
function ftsQuery(text: string) {
  const t = [...new Set(tokens(text))].filter((x) => x.length > 2).slice(0, 24);
  return t.length ? t.map((x) => `"${x.replace(/"/g, '')}"`).join(' OR ') : '';
}

/** Hybrid search with the agent's learned re-ranker. Optionally logs the retrieval for learning. */
export async function search(agentId: string, query: string, o: { k?: number; taskId?: string; log?: boolean; minScore?: number } = {}): Promise<Hit[]> {
  const k = o.k ?? 5;
  const agent = q.get('SELECT config_json FROM agents WHERE id = ?', agentId);
  const ranker: Ranker = { ...DEFAULT_RANKER, ...(json<any>(agent?.config_json, {}).ranker ?? {}) };
  const cand = new Map<string, { bm25: number }>();
  const fq = ftsQuery(query);
  if (fq) {
    try {
      for (const r of q.all('SELECT chunk_id, bm25(kb_fts) s FROM kb_fts WHERE kb_fts MATCH ? AND agent_id = ? ORDER BY s LIMIT 40', fq, agentId)) cand.set(r.chunk_id, { bm25: -r.s });
    } catch (e) { log.warn('kb fts query failed', String(e)); }
  }
  const rows = q.all(`SELECT c.id, c.doc_id, c.text, c.vector, c.embedder, c.uses, c.helpful, d.title, d.kind, d.confidence, d.updated_at
                      FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id WHERE c.agent_id = ? AND d.state = 'ready'`, agentId);
  if (!rows.length) return [];
  const qv = new Map<string, Float32Array>();
  for (const e of new Set(rows.map((r) => r.embedder ?? HASHED))) qv.set(e, (await embed([query], e)).vectors[0]);
  const maxBm = Math.max(1e-6, ...[...cand.values()].map((c) => c.bm25));
  const scored: Hit[] = rows.map((r) => {
    const v = fromBlob(r.vector);
    const qvec = qv.get(r.embedder ?? HASHED) ?? qv.get(HASHED)!;
    const cos = v && qvec && v.length === qvec.length ? Math.max(0, cosine(v, qvec)) : 0;
    const bm = cand.has(r.id) ? cand.get(r.id)!.bm25 / maxBm : 0;
    const useful = (r.helpful + 1) / (r.uses + 2);
    const ageDays = (now() - r.updated_at) / 86400_000;
    const f = [bm, cos, useful, r.kind === 'doc' ? 0 : 1, r.confidence, Math.exp(-ageDays / 60)];
    return { chunkId: r.id, docId: r.doc_id, title: r.title, kind: r.kind, text: r.text, features: f.map((x) => Math.round(x * 1000) / 1000), score: score(ranker, f) };
  }).filter((h) => h.features[0] > 0 || h.features[1] > 0.08);
  scored.sort((a, b) => b.score - a.score);
  // Diversity: at most two passages from one document.
  const per = new Map<string, number>();
  const top = scored.filter((h) => { const n = per.get(h.docId) ?? 0; if (n >= 2) return false; per.set(h.docId, n + 1); return true; })
    .filter((h) => h.score >= (o.minScore ?? 0.15)).slice(0, k);
  if (o.log !== false && top.length) {
    tx(() => {
      for (const h of top) {
        insert('retrievals', { id: uid('ret'), agent_id: agentId, task_id: o.taskId ?? null, query: query.slice(0, 500), chunk_id: h.chunkId, features_json: JSON.stringify(h.features), created_at: now() });
        q.run('UPDATE kb_chunks SET uses = uses + 1 WHERE id = ?', h.chunkId);
      }
      for (const d of new Set(top.map((h) => h.docId))) q.run('UPDATE kb_documents SET uses = uses + 1 WHERE id = ?', d);
    });
  }
  return top;
}

export function formatHits(hits: Hit[]) {
  return hits.map((h, i) => `[${i + 1}] ${h.kind === 'doc' ? h.title : `${h.kind === 'lesson' ? 'Lesson' : 'Skill'}: ${h.title}`} (relevance ${Math.round(h.score * 100)}%)\n${h.text}`).join('\n\n');
}

export function kbStats(agentId: string) {
  const d = q.get(`SELECT COUNT(*) docs, SUM(kind = 'lesson') lessons, SUM(kind = 'skill') skills, SUM(chars) chars FROM kb_documents WHERE agent_id = ? AND state != 'retired'`, agentId)!;
  const c = q.get('SELECT COUNT(*) n FROM kb_chunks WHERE agent_id = ?', agentId)!;
  return { documents: d.docs ?? 0, lessons: d.lessons ?? 0, skills: d.skills ?? 0, chars: d.chars ?? 0, passages: c.n, embedder: embedder() };
}
