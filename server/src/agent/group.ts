/**
 * The group chat: one room with you, AUDA and every agent at work.
 *  - Agents post when they start, publish a plan, need you, finish or fail.
 *  - @mention an agent to talk to it mid-task: the message lands in that
 *    task's inbox and the agent reads it at its next step (and can answer).
 *  - Mention a finished agent and AUDA starts a follow-up with its context.
 *  - "/task …" (or just asking) assigns new work; attached files and folders
 *    are handed to the agent with the task.
 */
import path from 'node:path';
import fs from 'node:fs';
import { insert, json, now, q, uid, update } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { on } from '../core/bus.ts';
import { activity } from '../core/activity.ts';
import { createTask, TERMINAL, kick } from '../tasks/engine.ts';
import { config } from '../core/config.ts';
import { saveArtifact } from '../artifacts/store.ts';
import { handleUserMessage } from './chat.ts';

export const GROUP_ID = 'group';

export function ensureGroup() {
  if (!q.get('SELECT id FROM conversations WHERE id = ?', GROUP_ID)) {
    insert('conversations', { id: GROUP_ID, channel: 'group', title: 'Team', created_at: now(), updated_at: now() });
    changed('conversation', GROUP_ID);
  }
}

export function agentName(task: Record<string, any>) {
  const short = task.title.length > 34 ? task.title.slice(0, 32).replace(/\s+\S*$/, '') + '…' : task.title;
  return `${task.depth ? 'Sub-agent' : 'Agent'} · ${short}`;
}

export function post(o: { text: string; authorType: 'user' | 'auda' | 'agent'; authorId?: string; objects?: { type: string; id: string }[]; attachments?: string[]; channel?: string }) {
  ensureGroup();
  const id = uid('msg');
  insert('messages', {
    id, conversation_id: GROUP_ID, role: o.authorType === 'user' ? 'user' : 'auda', content: o.text, objects_json: JSON.stringify(o.objects ?? []),
    channel: o.channel ?? 'web', author_type: o.authorType, author_id: o.authorId, attachments_json: JSON.stringify(o.attachments ?? []), created_at: now(),
  });
  update('conversations', GROUP_ID, { updated_at: now() });
  changed('message', id);
  return id;
}

/** Everyone you can address in the group. */
export function agents() {
  const rows = q.all(`SELECT id, title, state, depth, now_line, parent_task_id FROM tasks WHERE playbook = 'agent'
    AND (state NOT IN ('COMPLETED','FAILED','CANCELLED') OR completed_at > ?) ORDER BY created_at DESC LIMIT 40`, now() - 6 * 3600_000);
  return [
    { id: 'auda', name: 'AUDA', kind: 'coordinator', state: 'ACTIVE', nowLine: 'Coordinates the team and assigns work' },
    ...rows.map((t) => ({ id: t.id, name: agentName(t), kind: t.depth ? 'subagent' : 'agent', state: t.state, nowLine: t.now_line, parentId: t.parent_task_id })),
  ];
}

const describeFiles = (files: string[]) => files.length ? `\n\nFiles the user attached (in your computer’s filesystem):\n${files.map((f) => `- ${f}`).join('\n')}` : '';

/** Deliver a message to a task's inbox; the agent reads it at its next step. */
export function messageAgent(taskId: string, text: string, attachments: string[] = [], from = 'the user') {
  const t = q.get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!t) throw new Error('No such agent');
  if (TERMINAL.includes(t.state)) {
    // Finished agents don't come back to life; a follow-up inherits their context.
    const arts = q.all('SELECT path FROM artifacts WHERE task_id = ?', taskId).map((a) => a.path);
    const id = createTask({
      title: `Follow-up: ${text.length > 60 ? text.slice(0, 57) + '…' : text}`, goal: text, playbook: 'agent', spaceId: t.space_id, origin: { type: 'group', followUpOf: taskId },
      input: { context: `This follows up on an earlier task, “${t.title}”. Its outcome: ${t.result_summary ?? t.diagnosis ?? t.error ?? 'unknown'}.${arts.length ? ` Files it produced: ${arts.join(', ')}.` : ''}${describeFiles(attachments)}` },
    });
    post({ text: `${agentName(t)} has finished, so I started a follow-up with its context.`, authorType: 'auda', objects: [{ type: 'task', id }] });
    return { delivered: false, followUp: id };
  }
  const inbox = json<any[]>(t.inbox_json, []);
  inbox.push({ text: text + describeFiles(attachments), from, at: now() });
  update('tasks', taskId, { inbox_json: JSON.stringify(inbox) });
  changed('task', taskId);
  activity('user', `You messaged ${agentName(t)}`, { taskId, detail: text.slice(0, 300) });
  const busy = t.state === 'WAITING_USER' ? 'it’s waiting for your decision first' : t.waiting_on === 'children' ? 'it’s waiting for its sub-agents' : t.state === 'RETRYING' ? 'it’s retrying after a problem' : t.state === 'SCHEDULED' ? 'it hasn’t started yet' : null;
  if (busy) post({ text: `Delivered to ${agentName(t)} — ${busy}, so it will read this as soon as it continues.`, authorType: 'auda' });
  kick();
  return { delivered: true };
}

/** Take and clear a task's inbox (called by the agent loop at the start of a turn). */
export function drainInbox(taskId: string): { text: string; from: string; at: number }[] {
  const t = q.get('SELECT inbox_json FROM tasks WHERE id = ?', taskId);
  const items = json<any[]>(t?.inbox_json, []);
  if (items.length) update('tasks', taskId, { inbox_json: '[]' });
  return items;
}

export async function handleGroupMessage(o: { text: string; attachments?: string[]; mentions?: string[]; channel?: string; from?: string }) {
  const text = o.text.trim();
  const attachments = o.attachments ?? [];
  if (!text && !attachments.length) throw new Error('Say something or attach a file');
  const mentions = (o.mentions ?? []).filter((m) => m !== 'auda');
  post({ text: text || '(sent files)', authorType: 'user', attachments, channel: o.channel });
  for (const id of mentions) messageAgent(id, text, attachments, o.from ?? 'the user');
  if (mentions.length) return { routed: mentions };

  // Explicit assignment: "/task title | done when …"
  const m = /^\/(?:task|assign)\s+([\s\S]+)$/i.exec(text) ?? (attachments.length && !text ? ['', 'Look at the attached files and tell me what they are and what you suggest'] : null);
  if (m) {
    const [titleRaw, criteria] = m[1].split(/\s*\|\s*|\s+done when:?\s+/i);
    const title = titleRaw.trim().slice(0, 120);
    const id = createTask({ title, goal: m[1].trim() + describeFiles(attachments), playbook: 'agent', origin: { type: 'group' }, input: { criteria: criteria?.trim() || undefined, attachments } });
    post({ text: `Assigned. A new agent is on it.`, authorType: 'auda', objects: [{ type: 'task', id }] });
    return { taskId: id };
  }
  // Otherwise AUDA (the coordinator) handles it like any chat message, in the group.
  const reply = await handleUserMessage(GROUP_ID, text + describeFiles(attachments), o.channel ?? 'web', { skipUserMessage: true });
  return { reply };
}

/** Save an uploaded file into AUDA's inbox folder and record why it exists. */
export async function saveUpload(stream: NodeJS.ReadableStream, o: { name: string; dir?: string; from?: string; maxBytes?: number }) {
  const safe = (s: string) => s.replace(/\\/g, '/').split('/').map((p) => p.replace(/[^\p{L}\p{N}._ -]/gu, '_')).filter((p) => p && p !== '.' && p !== '..').join('/');
  const day = new Date().toISOString().slice(0, 10);
  const relDir = path.posix.join('inbox', day, safe(o.dir ?? ''));
  const absDir = path.join(config.workspaceDir, relDir);
  fs.mkdirSync(absDir, { recursive: true });
  let name = safe(o.name) || 'file';
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 1; fs.existsSync(path.join(absDir, name)); i++) name = `${base}-${i}${ext}`;
  const abs = path.join(absDir, name);
  const max = o.maxBytes ?? 512 * 1048576;
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(abs);
    stream.on('data', (c: Buffer) => { size += c.length; if (size > max) { stream.removeAllListeners('data'); out.destroy(); fs.rmSync(abs, { force: true }); reject(new Error('File is too large (limit 512 MB)')); } });
    stream.pipe(out);
    out.on('finish', () => resolve());
    out.on('error', reject);
    stream.on('error', reject);
  });
  const rel = `~/${relDir}/${name}`.replace(/\/+/g, '/');
  const id = uid('art');
  insert('artifacts', { id, name, path: rel, mime: guessMime(name), size, why: `Sent to AUDA${o.from ? ` from ${o.from}` : ''}`, created_at: now() });
  changed('artifact', id);
  return { path: rel, artifactId: id, size };
}
const guessMime = (n: string) => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json' } as Record<string, string>)[path.extname(n).toLowerCase()] ?? 'application/octet-stream';

/** Agents narrate their lifecycle into the group so you can supervise from one place. */
export function initGroup() {
  ensureGroup();
  const agentTask = (id?: string) => { const t = id ? q.get('SELECT * FROM tasks WHERE id = ?', id) : undefined; return t?.playbook === 'agent' ? t : undefined; };
  on('task.created', (e) => {
    const t = agentTask(e.subjectId); if (!t) return;
    const origin = json<any>(t.origin_json, {});
    if (origin.type === 'group' && !origin.followUpOf) return; // already announced by the assignment reply
    post({ text: t.depth ? `Started on my part: ${t.title}` : `I’m on it: ${t.title}`, authorType: 'agent', authorId: t.id, objects: t.depth ? [] : [{ type: 'task', id: t.id }] });
  });
  on('approval.requested', (e) => {
    const t = agentTask(e.payload.taskId); if (!t) return;
    post({ text: 'I need your decision before I continue.', authorType: 'agent', authorId: t.id, objects: [{ type: 'approval', id: e.subjectId! }] });
  });
  on('task.completed', (e) => {
    const t = agentTask(e.subjectId); if (!t) return;
    const v = json<any>(t.verification_json, null);
    post({ text: `${t.depth ? 'Done with my part' : 'Finished'}: ${t.result_summary ?? ''}${v?.verdict === 'pass' ? '\n✓ Independently reviewed against the done-when criteria.' : ''}`, authorType: 'agent', authorId: t.id, objects: t.depth ? [] : [{ type: 'task', id: t.id }] });
  });
  on('task.failed', (e) => {
    const t = agentTask(e.subjectId); if (!t) return;
    post({ text: `I couldn’t finish. ${t.diagnosis ?? t.error ?? ''}`, authorType: 'agent', authorId: t.id, objects: [{ type: 'task', id: t.id }] });
  });
}
