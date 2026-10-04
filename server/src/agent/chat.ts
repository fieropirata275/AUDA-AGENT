/**
 * Chat is a control surface into the one AUDA. Every channel (web, API,
 * linked devices, future Slack/Discord) lands here, and natural language is
 * mapped onto persistent state — responsibilities, tasks, rules, memories —
 * rather than answered and forgotten.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { insert, now, q, uid, update } from '../core/db.ts';
import { currentUserId } from '../core/context.ts';
import { changed } from '../core/changes.ts';
import { emit } from '../core/bus.ts';
import { activity } from '../core/activity.ts';
import { log } from '../core/log.ts';
import { compileIntent, findResponsibility, type Reply } from './intents.ts';
import { presenceSummary, setListening } from './presence.ts';
import { canUseTools, complete } from '../models/router.ts';
import { playbooks } from '../playbooks/types.ts';
import { createResponsibility, endResponsibility, pauseResponsibility, resumeResponsibility, wakeNow } from '../responsibilities/service.ts';
import { createTask } from '../tasks/engine.ts';
import { compileRule, createRule } from '../policy/rules.ts';
import { recall, remember } from '../memory/service.ts';
import { parseSchedule } from '../scheduler/fuzzy.ts';

export function ensureConversation(id?: string, spaceId?: string | null, channel = 'web') {
  if (id && q.get('SELECT id FROM conversations WHERE id = ?', id)) return id;
  const cid = id ?? uid('conv');
  insert('conversations', { id: cid, space_id: spaceId ?? undefined, channel, title: 'Conversation', user_id: currentUserId(), created_at: now(), updated_at: now() });
  changed('conversation', cid);
  return cid;
}

function addMessage(conversationId: string, role: 'user' | 'auda', content: string, objects: Reply['objects'] = [], channel = 'web', authorType = role === 'user' ? 'user' : 'auda') {
  const id = uid('msg');
  insert('messages', { id, conversation_id: conversationId, role, content, objects_json: JSON.stringify(objects), channel, author_type: authorType, created_at: now() });
  update('conversations', conversationId, { updated_at: now() });
  changed('message', id);
  return id;
}

export async function handleUserMessage(conversationId: string, text: string, channel = 'web', opts: { skipUserMessage?: boolean } = {}) {
  const conv = q.get('SELECT * FROM conversations WHERE id = ?', conversationId)!;
  const msgId = opts.skipUserMessage ? uid('msg') : addMessage(conversationId, 'user', text, [], channel);
  if (q.get("SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND role = 'user'", conversationId)!.n === 1) {
    update('conversations', conversationId, { title: text.slice(0, 60) }); changed('conversation', conversationId);
  }
  setListening();
  emit('message.received', { subjectType: 'conversation', subjectId: conversationId, payload: { channel } });
  let reply: Reply;
  try {
    reply = canUseTools() ? await withModel(conversationId, text, conv.space_id, msgId).catch((e) => {
      log.warn('model chat failed, using built-in compiler', String(e));
      return compileIntent(text, { spaceId: conv.space_id, messageId: msgId });
    }) : await compileIntent(text, { spaceId: conv.space_id, messageId: msgId });
  } catch (e) {
    reply = { text: `I couldn’t do that: ${(e as Error).message}`, objects: [] };
  }
  if (reply.objects.length) activity('user', `You asked: “${text.length > 70 ? text.slice(0, 67) + '…' : text}”`, { detail: reply.text.split('\n')[0] });
  addMessage(conversationId, 'auda', reply.text, reply.objects, channel, 'auda');
  return reply;
}

// ─── model path ──────────────────────────────────────────────────────────────

const CHAT_TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: 'take_responsibility', description: 'Create an ongoing responsibility (it stays alive and wakes on its own). Use for "keep an eye on", "watch", "every week", "make sure", "take care of".', input_schema: { type: 'object', properties: {
    playbook: { type: 'string', enum: ['server.health', 'web.watch', 'github.ci', 'routine.report', 'routine.reminder', 'webhook.react'] },
    title: { type: 'string' }, config: { type: 'object', description: 'web.watch: {url, intervalSec, keywords?, focus?}; github.ci: {repo, branch?}; routine.report: {title, when (natural language)}; routine.reminder: {text, when}; webhook.react: {slug, keywords?}; server.health: {} (defaults)' },
  }, required: ['playbook', 'title', 'config'] } },
  { name: 'start_task', description: 'Start a finite piece of open-ended work AUDA will execute autonomously with its computer, browser and memory. Optional when: natural-language time to start later.', input_schema: { type: 'object', properties: { title: { type: 'string' }, goal: { type: 'string' }, when: { type: 'string' } }, required: ['title', 'goal'] } },
  { name: 'propose_rule', description: 'Turn a user policy statement ("never…", "always ask before…", "you can… without asking") into a draft rule the user must activate.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'remember', description: 'Store a memory. weight=defining only if the user says it defines how things work.', input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['identity', 'preference', 'semantic', 'relationship', 'project', 'procedural'] }, title: { type: 'string' }, content: { type: 'string' }, weight: { type: 'string', enum: ['mentioned', 'established', 'defining'] } }, required: ['kind', 'title', 'content'] } },
  { name: 'control_responsibility', description: 'Pause, resume, stop or check-now an existing responsibility, found by a description.', input_schema: { type: 'object', properties: { which: { type: 'string' }, action: { type: 'string', enum: ['pause', 'resume', 'stop', 'check_now'] } }, required: ['which', 'action'] } },
  { name: 'look_up', description: 'Search AUDA\'s memory, activity and tasks to answer questions like "why did you…" or "what happened with…".', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];

async function withModel(conversationId: string, text: string, spaceId: string | null, msgId: string): Promise<Reply> {
  const history = q.all('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 16', conversationId).reverse();
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of history) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    if (messages.length && messages[messages.length - 1].role === role) messages[messages.length - 1].content += `\n\n${m.content}`;
    else messages.push({ role, content: m.content });
  }
  if (messages[0]?.role !== 'user') messages.shift();
  const resps = q.all("SELECT id, title, state, status_line FROM responsibilities WHERE state != 'ENDED'");
  const memories = recall(text, { spaceId, limit: 8 });
  const system = `You are AUDA, a persistent autonomous digital operator. Chat is only one interface into you: you keep working after it closes. Map requests onto persistent state with tools — "keep an eye on X every day" creates a responsibility, "never do Y" proposes a rule, "remember Z" stores a memory, a piece of work starts a task. Then reply briefly (1-3 sentences), calmly, in the user's language. Never claim to have done something you didn't do with a tool.

Current state:
${presenceSummary()}

Responsibilities:
${resps.map((r) => `- ${r.title} [${r.state}] ${r.status_line ?? ''}`).join('\n') || '- none'}

Relevant memories:
${memories.map((m) => `- (${m.kind}, ${m.weight}) ${m.title}: ${m.content}`).join('\n') || '- none'}

Playbooks: ${playbooks().map((p) => `${p.id} — ${p.description}`).join('; ')}`;

  const objects: Reply['objects'] = [];
  for (let i = 0; i < 4; i++) {
    const r = await complete({ role: 'reasoning', purpose: 'chat', system, messages, tools: CHAT_TOOLS, maxTokens: 4000, effort: 'low' });
    messages.push({ role: 'assistant', content: r.content });
    if (!r.toolUses.length) return { text: r.text.trim() || 'Done.', objects };
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const tu of r.toolUses) {
      let out: string;
      try { out = await runChatTool(tu.name, tu.input, spaceId, msgId, objects); } catch (e) { out = `Error: ${(e as Error).message}`; }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
    }
    messages.push({ role: 'user', content: results });
  }
  return { text: 'Done.', objects };
}

async function runChatTool(name: string, i: any, spaceId: string | null, msgId: string, objects: Reply['objects']): Promise<string> {
  const origin = { type: 'chat', messageId: msgId };
  switch (name) {
    case 'take_responsibility': {
      const config = { ...(i.config ?? {}) };
      if (i.playbook === 'server.health') Object.assign(config, { service: 'demo-api', path: '~/services/demo-api', quotaBytes: 48 * 1048576, thresholdPct: 80, rearmPct: 60, intervalSec: 5 }, i.config);
      if (config.when) { const s = parseSchedule(config.when); if (!s) return 'Could not understand the schedule'; config.schedule = s; config.scheduleText = s.description; }
      if (i.playbook === 'web.watch') config.intervalSec ??= 3600;
      const id = createResponsibility({ playbook: i.playbook, title: i.title, config, spaceId, origin });
      objects.push({ type: 'responsibility', id });
      return `created responsibility ${id}`;
    }
    case 'start_task': {
      const s = i.when ? parseSchedule(i.when) : null;
      const id = createTask({ title: i.title, goal: i.goal, playbook: 'agent', spaceId, origin, runAt: s?.nextRunAt });
      objects.push({ type: 'task', id });
      return `started task ${id}${s ? ` scheduled ${s.description}` : ''}`;
    }
    case 'propose_rule': {
      const c = await compileRule(i.text);
      if (!c) return 'Could not compile that rule';
      const id = createRule(i.text, { ...c, spaceId, origin: 'chat' });
      objects.push({ type: 'rule', id });
      return `draft rule ${id}: ${c.interpretation}`;
    }
    case 'remember': {
      const id = remember({ kind: i.kind, title: i.title, content: i.content, weight: i.weight, source: 'chat', sourceRef: msgId, spaceId, confidence: 0.95, expiresAt: null });
      objects.push({ type: 'memory', id });
      return 'remembered';
    }
    case 'control_responsibility': {
      const r = findResponsibility(i.which);
      if (!r) return 'No matching responsibility';
      if (i.action === 'pause') pauseResponsibility(r.id); else if (i.action === 'resume') resumeResponsibility(r.id);
      else if (i.action === 'stop') endResponsibility(r.id); else { const t = await wakeNow(r.id); if (t) objects.push({ type: 'task', id: t }); }
      objects.push({ type: 'responsibility', id: r.id });
      return `${i.action} done on “${r.title}”`;
    }
    case 'look_up': {
      const mem = recall(i.query, { limit: 5 }).map((m) => `memory: ${m.title} — ${m.content}`);
      const words = (i.query as string).toLowerCase().match(/[a-z0-9-]{4,}/g) ?? [];
      const acts = q.all('SELECT a.title, a.detail, a.ts, a.task_id FROM activity a ORDER BY ts DESC LIMIT 300')
        .filter((a) => words.some((w) => `${a.title} ${a.detail ?? ''}`.toLowerCase().includes(w))).slice(0, 12)
        .map((a) => `${new Date(a.ts).toLocaleString()}: ${a.title}${a.detail ? ` — ${a.detail.slice(0, 200)}` : ''}`);
      return [...mem, ...acts].join('\n') || 'Nothing found';
    }
  }
  return 'unknown tool';
}

