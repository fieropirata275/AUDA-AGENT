/**
 * How custom agents get better on their own.
 *
 *  1. Retrieval learning — every passage an agent retrieves is logged with its
 *     ranking features. When the task ends, each log entry is labelled: did
 *     the agent actually use the passage (its distinctive terms show up in the
 *     agent's own reasoning, tool inputs, answer or files — never counting the
 *     retrieval output itself)? Ratings from people override that signal. The
 *     agent's logistic-regression re-ranker then takes online SGD steps on the
 *     new labels, so what helped before ranks higher next time.
 *  2. Reflection — after each finished task the agent writes short lessons
 *     (what worked, what the reviewer or the person corrected) into its own
 *     knowledge base, deduplicated against what it already knows. A working
 *     tool sequence becomes a reusable "skill".
 *  3. Feedback — 👍/👎 and comments from people become labels and, for
 *     corrections, high-confidence lessons.
 *  4. Maintenance — lessons that keep being retrieved but never help decay and
 *     retire; sources the agent studies are re-read on schedule and re-indexed
 *     when they change.
 *
 * Everything here is best-effort and never blocks or fails the task itself.
 */
import fs from 'node:fs';
import { insert, json, now, q, tx, uid, update } from '../core/db.ts';
import { on } from '../core/bus.ts';
import { activity } from '../core/activity.ts';
import { changed } from '../core/changes.ts';
import { log } from '../core/log.ts';
import { completeJson, hasReasoningModel } from '../models/router.ts';
import { resolveWs } from '../computer/files.ts';
import { addDocument, cosine, fetchUrlText, hashedEmbedding, tokens, score, DEFAULT_RANKER, FEATURES, type Ranker } from './knowledge.ts';
import { agentConfig, getAgent, saveConfig } from './agents.ts';

const USE_THRESHOLD = 0.3;
const MAX_LESSONS = 200;

// ─── 1. labelling and the re-ranker ──────────────────────────────────────────

/** Text the agent itself produced in a task: its reasoning, tool inputs, answer and files (not tool results). */
export function producedText(taskId: string): string {
  const t = q.get('SELECT result_summary, checkpoint_json FROM tasks WHERE id = ?', taskId);
  if (!t) return '';
  const parts: string[] = [t.result_summary ?? ''];
  for (const m of json<any>(t.checkpoint_json, {}).messages ?? []) {
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string') parts.push(m.content);
    else for (const b of m.content ?? []) {
      if (b.type === 'text') parts.push(b.text ?? '');
      if (b.type === 'tool_use' && !['search_knowledge', 'recall'].includes(b.name)) parts.push(JSON.stringify(b.input ?? {}));
    }
  }
  for (const a of q.all("SELECT path, mime FROM artifacts WHERE task_id = ? AND (mime LIKE 'text%' OR mime LIKE '%json%' OR mime LIKE '%markdown%')", taskId)) {
    try { parts.push(fs.readFileSync(resolveWs(a.path), 'utf8').slice(0, 40_000)); } catch { /* moved */ }
  }
  return parts.join('\n');
}

/** Share of a passage's distinctive terms (≥ 4 chars) that appear in what the agent produced. */
export function usage(passage: string, produced: Set<string>) {
  const terms = [...new Set(tokens(passage).filter((x) => x.length >= 4))];
  if (!terms.length) return 0;
  return terms.filter((x) => produced.has(x)).length / terms.length;
}

export function labelTask(taskId: string) {
  const rows = q.all('SELECT r.id, r.chunk_id, c.text FROM retrievals r JOIN kb_chunks c ON c.id = r.chunk_id WHERE r.task_id = ? AND r.label IS NULL', taskId);
  if (!rows.length) return 0;
  const produced = new Set(tokens(producedText(taskId)));
  tx(() => {
    for (const r of rows) {
      const used = usage(r.text, produced) >= USE_THRESHOLD;
      q.run('UPDATE retrievals SET label = ?, trained = 0 WHERE id = ?', used ? 1 : 0, r.id);
      if (used) q.run('UPDATE kb_chunks SET helpful = helpful + 1 WHERE id = ?', r.chunk_id);
    }
  });
  return rows.length;
}

/** Online logistic regression: SGD over labelled, not-yet-trained retrievals. */
export function train(agentId: string) {
  const rows = q.all('SELECT id, features_json, label FROM retrievals WHERE agent_id = ? AND label IS NOT NULL AND trained = 0 ORDER BY created_at LIMIT 2000', agentId);
  if (!rows.length) return null;
  const a = getAgent(agentId);
  if (!a) return null;
  const r: Ranker = { ...DEFAULT_RANKER, ...(agentConfig(a).ranker ?? {}) };
  r.w = [...r.w];
  while (r.w.length < FEATURES.length) r.w.push(0);
  let correct = 0; let positives = 0;
  for (const row of rows) {
    const f = json<number[]>(row.features_json, []);
    const y = Number(row.label) >= 0.5 ? 1 : 0;
    const p = score(r, f);
    if ((p >= 0.5 ? 1 : 0) === y) correct++;
    positives += y;
    const lr = 0.4 / Math.sqrt(1 + r.n / 40);
    const g = p - y;
    for (let i = 0; i < r.w.length; i++) r.w[i] -= lr * (g * (f[i] ?? 0) + 0.001 * r.w[i]);
    r.b -= lr * g;
    r.n++;
  }
  r.w = r.w.map((x) => Math.round(x * 10_000) / 10_000); r.b = Math.round(r.b * 10_000) / 10_000;
  q.run(`UPDATE retrievals SET trained = 1 WHERE id IN (${rows.map(() => '?').join(',')})`, ...rows.map((x) => x.id));
  const entry = { at: now(), labelled: rows.length, positives, accuracy: Math.round((correct / rows.length) * 100) / 100, lessons: q.get("SELECT COUNT(*) n FROM kb_documents WHERE agent_id = ? AND kind IN ('lesson','skill') AND state = 'ready'", agentId)!.n };
  saveConfig(agentId, (c) => { c.ranker = r; c.learning = { reflect: c.learning?.reflect ?? true, history: [...(c.learning?.history ?? []), entry].slice(-60) }; });
  return entry;
}

// ─── 2. reflection ───────────────────────────────────────────────────────────

/** Store a lesson unless the agent already knows it (then it just gains confidence). */
export async function addLesson(agentId: string, title: string, text: string, o: { kind?: 'lesson' | 'skill'; confidence?: number; source?: 'lesson' | 'skill' | 'task'; sourceRef?: string } = {}) {
  const v = hashedEmbedding(`${title}\n${text}`);
  for (const d of q.all("SELECT d.id, d.confidence, c.text FROM kb_documents d JOIN kb_chunks c ON c.doc_id = d.id AND c.idx = 0 WHERE d.agent_id = ? AND d.kind = ? AND d.state = 'ready'", agentId, o.kind ?? 'lesson')) {
    if (cosine(v, hashedEmbedding(d.text)) > 0.85) {
      update('kb_documents', d.id, { confidence: Math.min(1, d.confidence + 0.1), updated_at: now() });
      changed('knowledge', d.id);
      return { id: d.id, duplicate: true };
    }
  }
  const id = await addDocument({ agentId, title, text, source: o.source ?? (o.kind === 'skill' ? 'skill' : 'lesson'), sourceRef: o.sourceRef, kind: o.kind ?? 'lesson', confidence: o.confidence ?? 0.6 });
  // Keep the lesson set bounded: retire the weakest beyond the cap.
  const extra = q.get("SELECT COUNT(*) n FROM kb_documents WHERE agent_id = ? AND kind IN ('lesson','skill') AND state = 'ready'", agentId)!.n - MAX_LESSONS;
  if (extra > 0) q.run(`UPDATE kb_documents SET state = 'retired' WHERE id IN (SELECT id FROM kb_documents WHERE agent_id = ? AND kind IN ('lesson','skill') AND state = 'ready' ORDER BY confidence, updated_at LIMIT ?)`, agentId, extra);
  return { id, duplicate: false };
}

function toolSequence(taskId: string): string[] {
  const t = q.get('SELECT checkpoint_json FROM tasks WHERE id = ?', taskId);
  const seq: string[] = [];
  for (const m of json<any>(t?.checkpoint_json, {}).messages ?? []) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content ?? []) if (b.type === 'tool_use' && !['narrate', 'update_plan', 'reply_to_user'].includes(b.name)) {
      const hint = b.name === 'terminal' ? `terminal: ${String(b.input?.cmd ?? '').slice(0, 80)}` : b.name;
      if (seq[seq.length - 1] !== hint) seq.push(hint);
    }
  }
  return seq.slice(0, 24);
}

export async function reflect(taskId: string) {
  const t = q.get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!t?.agent_id || t.parent_task_id) return [];
  const a = getAgent(t.agent_id);
  if (!a || agentConfig(a).learning?.reflect === false) return [];
  const ver = json<any>(t.verification_json, null);
  const fb = q.all('SELECT rating, comment FROM agent_feedback WHERE task_id = ?', taskId);
  const seq = toolSequence(taskId);
  const criteria = json<any>(t.input_json, {}).criteria;
  const out: { title: string; text: string; kind: 'lesson' | 'skill' }[] = [];
  if (hasReasoningModel()) {
    try {
      const j = await completeJson<any>({
        role: 'utility', purpose: 'agent reflection', taskId, maxTokens: 2000,
        json: { name: 'reflection', schema: { type: 'object', properties: { lessons: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, lesson: { type: 'string' } }, required: ['title', 'lesson'] } }, skill: { type: 'object', properties: { title: { type: 'string' }, steps: { type: 'string' } } } }, required: ['lessons'] } },
        system: `You help the agent "${a.name}" learn from finished work. Write lessons that would make the next similar task go better: specific, actionable, reusable — not a summary of this task. Return JSON only: {"lessons":[{"title":"short","lesson":"1-3 sentences"}],"skill":{"title":"short name for this kind of task","steps":"the approach that worked, as numbered steps"} | null}. At most 3 lessons; return an empty list if nothing is worth keeping.`,
        prompt: `TASK: ${t.title}\nGOAL: ${t.goal ?? ''}\nDONE WHEN: ${criteria ?? '-'}\nOUTCOME: ${t.state}\nRESULT: ${(t.result_summary ?? t.diagnosis ?? t.error ?? '').slice(0, 3000)}\nREVIEW: ${ver ? `${ver.verdict} — ${(ver.issues ?? []).join('; ')}` : '-'}\nFEEDBACK: ${fb.map((f) => `${f.rating > 0 ? '+' : '-'} ${f.comment ?? ''}`).join(' | ') || '-'}\nTOOLS USED IN ORDER: ${seq.join(' → ') || '-'}`,
      });
      for (const l of (j.lessons ?? []).slice(0, 3)) if (l?.title && l?.lesson) out.push({ title: String(l.title).slice(0, 120), text: String(l.lesson).slice(0, 1200), kind: 'lesson' });
      if (t.state === 'COMPLETED' && j.skill?.title && j.skill?.steps) out.push({ title: String(j.skill.title).slice(0, 120), text: String(j.skill.steps).slice(0, 2000), kind: 'skill' });
    } catch (e) { log.warn('reflection via model failed; using heuristics', String(e)); }
  }
  if (!out.length) {
    if (ver?.issues?.length) out.push({ title: `Check before finishing: ${t.title.slice(0, 60)}`, text: `On a task like “${t.title}”, the reviewer flagged: ${ver.issues.slice(0, 4).join('; ')}. Check these before giving the final answer.`, kind: 'lesson' });
    if (t.state === 'FAILED' && (t.diagnosis || t.error)) out.push({ title: `What went wrong: ${t.title.slice(0, 60)}`, text: `A task like “${t.title}” failed: ${(t.diagnosis ?? t.error).slice(0, 400)}. Plan around this next time.`, kind: 'lesson' });
    if (t.state === 'COMPLETED' && seq.length >= 2 && ver?.verdict !== 'fail') out.push({ title: `How to: ${t.title.slice(0, 80)}`, text: `An approach that worked for “${t.title}”:\n${seq.map((s, i) => `${i + 1}. ${s}`).join('\n')}`, kind: 'skill' });
  }
  const saved: string[] = [];
  for (const l of out) {
    const r = await addLesson(a.id, l.title, l.text, { kind: l.kind, confidence: l.kind === 'skill' ? 0.55 : ver?.issues?.length ? 0.7 : 0.6, source: 'task', sourceRef: taskId });
    if (!r.duplicate) saved.push(l.title);
  }
  if (saved.length) activity('memory', `${a.name} learned ${saved.length} thing${saved.length > 1 ? 's' : ''} from “${t.title}”`, { detail: saved.map((s) => `• ${s}`).join('\n'), taskId });
  return saved;
}

// ─── 3. feedback ─────────────────────────────────────────────────────────────

export async function applyFeedback(taskId: string, rating: 1 | -1, comment: string | undefined, userId: string) {
  const t = q.get('SELECT id, title, agent_id FROM tasks WHERE id = ?', taskId);
  if (!t) throw new Error('No such task');
  update('tasks', taskId, { rating });
  changed('task', taskId);
  if (!t.agent_id) return { learned: false };
  insert('agent_feedback', { id: uid('afb'), agent_id: t.agent_id, task_id: taskId, user_id: userId, rating, comment: comment?.slice(0, 2000) ?? null, created_at: now() });
  labelTask(taskId);
  tx(() => {
    if (rating > 0) {
      // Endorsed: what it used was helpful.
      for (const r of q.all('SELECT DISTINCT r.chunk_id, c.doc_id FROM retrievals r JOIN kb_chunks c ON c.id = r.chunk_id WHERE r.task_id = ? AND r.label = 1', taskId)) {
        q.run('UPDATE kb_documents SET helpful = helpful + 1, confidence = MIN(1, confidence + 0.05) WHERE id = ?', r.doc_id);
      }
    } else {
      // Rejected: what it leaned on didn't lead to a good result.
      q.run('UPDATE retrievals SET label = 0, trained = 0 WHERE task_id = ? AND label = 1', taskId);
      q.run(`UPDATE kb_documents SET confidence = MAX(0.05, confidence * 0.85) WHERE kind IN ('lesson','skill') AND id IN (SELECT c.doc_id FROM retrievals r JOIN kb_chunks c ON c.id = r.chunk_id WHERE r.task_id = ?)`, taskId);
    }
  });
  if (comment?.trim()) {
    const who = q.get('SELECT name FROM users WHERE id = ?', userId)?.name ?? 'the user';
    await addLesson(t.agent_id, rating > 0 ? `What ${who} liked: ${t.title.slice(0, 60)}` : `Correction from ${who}: ${t.title.slice(0, 60)}`,
      rating > 0 ? `On “${t.title}”, ${who} said this was good: ${comment.trim()}. Keep doing this.` : `On “${t.title}”, ${who} said: ${comment.trim()}. Do it this way next time.`,
      { confidence: rating > 0 ? 0.75 : 0.9, source: 'lesson', sourceRef: taskId });
  }
  const entry = train(t.agent_id);
  changed('agent', t.agent_id);
  return { learned: true, ranker: entry };
}

// ─── 4. maintenance and study ────────────────────────────────────────────────

export function decayLessons() {
  q.run(`UPDATE kb_documents SET confidence = confidence * 0.85, updated_at = ? WHERE kind IN ('lesson','skill') AND state = 'ready' AND uses >= 5 AND CAST(helpful AS REAL) / uses < 0.15`, now());
  const retired = q.run(`UPDATE kb_documents SET state = 'retired' WHERE kind IN ('lesson','skill') AND state = 'ready' AND confidence < 0.25`).changes;
  return Number(retired);
}

export async function study(agentId?: string, force = false) {
  const agents = agentId ? [getAgent(agentId)].filter((x): x is NonNullable<typeof x> => !!x) : q.all('SELECT * FROM agents WHERE archived = 0');
  let updated = 0;
  for (const a of agents) {
    const cfg = agentConfig(a);
    if (!force && cfg.study?.enabled === false) continue;
    for (const s of cfg.sources ?? []) {
      if (!force && s.lastFetchedAt && now() - s.lastFetchedAt < s.everyHours * 3600_000) continue;
      try {
        const page = await fetchUrlText(s.url);
        const changedContent = page.hash !== s.lastHash;
        if (changedContent) {
          const exists = s.docId && q.get('SELECT id FROM kb_documents WHERE id = ?', s.docId);
          const docId = await addDocument({ agentId: a.id, title: page.title, text: page.text, source: 'url', sourceRef: s.url, replaceId: exists ? s.docId : undefined });
          saveConfig(a.id, (c) => { const x = c.sources?.find((y) => y.id === s.id); if (x) Object.assign(x, { docId, lastHash: page.hash, lastFetchedAt: now(), error: null }); });
          if (s.lastHash) activity('memory', `${a.name} studied an update to ${new URL(s.url).host}`, { detail: `${page.title} changed; its knowledge was refreshed.` });
          updated++;
        } else {
          saveConfig(a.id, (c) => { const x = c.sources?.find((y) => y.id === s.id); if (x) Object.assign(x, { lastFetchedAt: now(), error: null }); });
        }
      } catch (e) {
        saveConfig(a.id, (c) => { const x = c.sources?.find((y) => y.id === s.id); if (x) Object.assign(x, { lastFetchedAt: now(), error: String((e as Error).message).slice(0, 300) }); });
      }
    }
  }
  return updated;
}

export function exportTraining(agentId: string): string {
  const rows = q.all('SELECT r.query, r.features_json, r.label, c.text, r.created_at FROM retrievals r JOIN kb_chunks c ON c.id = r.chunk_id WHERE r.agent_id = ? AND r.label IS NOT NULL ORDER BY r.created_at', agentId);
  const fb = q.all('SELECT f.rating, f.comment, t.title, t.goal, t.result_summary FROM agent_feedback f LEFT JOIN tasks t ON t.id = f.task_id WHERE f.agent_id = ? ORDER BY f.created_at', agentId);
  return [
    ...rows.map((r) => JSON.stringify({ type: 'retrieval', query: r.query, passage: r.text, features: Object.fromEntries(FEATURES.map((k, i) => [k, json<number[]>(r.features_json, [])[i]])), label: r.label, at: r.created_at })),
    ...fb.map((f) => JSON.stringify({ type: 'feedback', task: f.title, goal: f.goal, result: f.result_summary, rating: f.rating, comment: f.comment })),
  ].join('\n') + '\n';
}

let timer: NodeJS.Timeout | undefined;
export function initLearning() {
  const finished = async (taskId?: string) => {
    if (!taskId) return;
    const t = q.get('SELECT agent_id, parent_task_id FROM tasks WHERE id = ?', taskId);
    if (!t?.agent_id) return;
    try {
      labelTask(taskId);
      train(t.agent_id);
      if (!t.parent_task_id) await reflect(taskId);
    } catch (e) { log.warn('learning after task failed', String(e)); }
  };
  on('task.completed', (e) => finished(e.subjectId));
  on('task.failed', (e) => finished(e.subjectId));
  timer = setInterval(() => {
    try { decayLessons(); } catch (e) { log.warn('lesson decay failed', String(e)); }
    void study().catch((e) => log.warn('agent study failed', String(e)));
  }, Number(process.env.AUDA_STUDY_INTERVAL_MS ?? 3600_000));
  timer.unref?.();
}
