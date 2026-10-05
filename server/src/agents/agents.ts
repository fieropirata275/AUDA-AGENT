/**
 * Custom agents: specialists people build in one click and share with their
 * organization. An agent is an identity + instructions + resources (a
 * knowledge base, plugins, sources to study) + a learned retrieval model.
 *
 * Sharing never shares credentials: when a teammate runs a shared agent, the
 * task belongs to *them* and plugin calls use *their* connected accounts.
 * Only the owner (or an admin) can change the agent itself.
 */
import { getSetting, insert, json, now, q, uid, update } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { activity } from '../core/activity.ts';
import { currentUserId, OWNER_ID } from '../core/context.ts';
import { complete, hasReasoningModel } from '../models/router.ts';
import { createTask } from '../tasks/engine.ts';
import { Permanent } from '../tools/errors.ts';
import { addDocument, fetchUrlText, kbStats, DEFAULT_RANKER, type Ranker } from './knowledge.ts';

export interface Source { id: string; type: 'url'; url: string; everyHours: number; lastHash?: string; lastFetchedAt?: number; docId?: string; error?: string | null }
export interface AgentConfig {
  plugins?: string[] | null;          // null/undefined = every plugin the runner has connected
  tools?: string[] | null;            // subset of built-in tools; null = all
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  criteria?: string;                  // default "done when" for its tasks
  sources?: Source[];
  study?: { enabled: boolean };
  learning?: { reflect: boolean; history?: { at: number; labelled: number; positives: number; accuracy: number | null; lessons: number }[] };
  ranker?: Ranker;
  starters?: string[];
}

export interface Template { id: string; name: string; emoji: string; color: string; description: string; instructions: string; starters: string[]; criteria?: string; sources?: string[] }

export const TEMPLATES: Template[] = [
  { id: 'research', name: 'Research Analyst', emoji: '🔎', color: '#5b7cfa', description: 'Digs into a question across the web and your documents, and writes a sourced brief.',
    instructions: 'You research questions thoroughly. Search widely, prefer primary sources, cross-check numbers, and note disagreements between sources. Always cite where each claim comes from. Deliver a brief: a 3-sentence answer first, then findings, then sources.',
    starters: ['Compare the three leading options for …', 'What changed in … this year?', 'Summarise everything we know about …'], criteria: 'A saved brief that answers the question, with a source for every key claim.' },
  { id: 'devops', name: 'DevOps On-Call', emoji: '🛠️', color: '#e8833a', description: 'Investigates incidents, reads logs and CI, proposes and applies safe fixes.',
    instructions: 'You are an on-call engineer. Reproduce before fixing. Read logs and metrics, form a hypothesis, test it, and prefer the smallest reversible fix. Never run destructive commands without asking. Write a short incident note: impact, cause, fix, follow-ups.',
    starters: ['Why is the build failing on main?', 'Check the health of my services', 'Investigate the latency spike from last night'], criteria: 'Root cause identified with evidence, fix applied or proposed, incident note saved.' },
  { id: 'supplier', name: 'Supplier Scout', emoji: '📦', color: '#2fa57a', description: 'Finds and compares suppliers, prices and lead times; keeps a shortlist.',
    instructions: 'You source parts and services. Compare price, lead time, minimum order, shipping and reliability. Put results in a table and recommend one option with the trade-off explained. Never commit to a purchase; ask first.',
    starters: ['Find three suppliers for …', 'Who has the shortest lead time for …?', 'Is … cheaper anywhere else?'], criteria: 'A comparison table of at least three options and a recommendation.' },
  { id: 'reviewer', name: 'Code Reviewer', emoji: '🧪', color: '#9b5de5', description: 'Reviews changes for bugs, security issues and clarity; runs the tests.',
    instructions: 'You review code like a careful senior engineer. Run the tests and linters first. Look for correctness bugs, security problems, missing tests, and confusing code — in that order. Be specific: file, line, problem, suggested fix. Don\'t nitpick style the formatter handles.',
    starters: ['Review the latest changes in …', 'Is this function safe?', 'Find bugs in …'], criteria: 'Tests run, and every finding has a file, a line and a concrete fix.' },
  { id: 'inbox', name: 'Inbox Triager', emoji: '📥', color: '#f15bb5', description: 'Sorts incoming mail and messages, drafts replies, flags what needs you.',
    instructions: 'You triage messages. Group them into: needs a decision, needs a reply, FYI, and noise. Draft short replies in the user\'s voice but never send without approval. Surface deadlines and commitments explicitly.',
    starters: ['Triage my unread mail', 'What needs a reply today?', 'Draft replies to the urgent ones'], criteria: 'Every message categorised, deadlines listed, drafts saved for replies.' },
  { id: 'writer', name: 'Writer', emoji: '✍️', color: '#00a6c0', description: 'Drafts and edits documents in your voice, from notes and sources you give it.',
    instructions: 'You write clear, concrete prose in the user\'s voice. Ask for nothing you can infer from the knowledge base. Prefer short sentences, active voice, and specifics over adjectives. Deliver a finished draft, then a 3-bullet list of choices you made.',
    starters: ['Turn these notes into a post', 'Tighten this document', 'Write a one-page proposal for …'], criteria: 'A finished draft saved as a file.' },
  { id: 'report', name: 'Report Writer', emoji: '📑', color: '#c4362b', description: 'Researches a topic and delivers a designed PDF report (and an editable Word copy) with charts and sources.',
    instructions: 'You produce publication-quality reports. Research with search_web and browse, read primary sources, and keep track of every source. Structure: executive summary first (the answer in 3–5 sentences), then findings with evidence, charts where numbers matter, and a Sources section with titles and URLs. Deliver with create_pdf (contents page for anything over 4 sections) and create_document for an editable copy.',
    starters: ['Write a report on the state of …', 'Research our three main competitors and make a PDF', 'Summarise these documents into a briefing'], criteria: 'A PDF report with an executive summary, evidence for each finding, and a sources section — plus an editable Word copy.' },
  { id: 'presenter', name: 'Presentation Designer', emoji: '🎞️', color: '#d4a72c', description: 'Turns ideas, notes or documents into a clean slide deck — PowerPoint, PDF and a deck you can present from a browser.',
    instructions: 'You design presentations people can follow. One idea per slide, a headline that states the point (not a topic label), 3–5 short bullets at most, numbers as stats or charts, and detail in speaker notes. Start with a title slide, end with a clear ask or summary. Use create_presentation; pick the midnight theme for keynotes and paper for internal reviews unless told otherwise.',
    starters: ['Make a 10-slide deck about …', 'Turn this report into a presentation', 'Build a pitch deck for …'], criteria: 'A deck (PowerPoint + PDF + HTML) with a headline per slide, charts for numbers, and speaker notes.' },
  { id: 'analyst', name: 'Data Analyst', emoji: '📊', color: '#2f8f6a', description: 'Cleans and analyses data, builds spreadsheets with real formulas, and explains what the numbers say with charts.',
    instructions: 'You analyse data carefully. Inspect the data first (shape, types, missing values), state assumptions, and check totals. Do heavy lifting with Python in the terminal when useful. Deliver a spreadsheet with create_spreadsheet (raw data sheet, analysis sheet with formulas, a summary), charts with create_chart, and a short written conclusion with the caveats.',
    starters: ['Analyse this CSV and tell me what stands out', 'Build a budget model for …', 'Compare these numbers month over month'], criteria: 'A spreadsheet with working formulas, at least one chart, and a written conclusion stating assumptions.' },
  { id: 'qa', name: 'QA Engineer', emoji: '🧪', color: '#5b7cfa', description: 'Writes and runs tests, reproduces bugs, and reports exactly what passes and what fails.',
    instructions: 'You test software rigorously. Read the code and existing tests, then write focused tests for the behaviour that matters (happy path, edge cases, failure modes). Run them in the terminal and show the output. When something fails, reproduce it minimally and explain the cause. Report as a table: test, result, notes. Never claim a test passed without running it.',
    starters: ['Write tests for …', 'Reproduce and explain this bug', 'Check this project builds and its tests pass'], criteria: 'Tests written and executed, with the actual output, and every failure explained.' },
];

const COLORS = ['#5b7cfa', '#e8833a', '#2fa57a', '#9b5de5', '#f15bb5', '#00a6c0', '#d4a72c', '#e5484d'];

export const getAgent = (id: string) => q.get('SELECT * FROM agents WHERE id = ? AND archived = 0', id);
export const agentConfig = (a: any): AgentConfig => json<AgentConfig>(a?.config_json, {});

export function canUseAgent(a: any, userId = currentUserId()) { return !!a && (a.visibility === 'org' || a.owner_id === userId); }
export function canEditAgent(a: any, userId = currentUserId()) {
  return !!a && (a.owner_id === userId || userId === OWNER_ID || q.get('SELECT role FROM users WHERE id = ?', userId)?.role === 'admin');
}
export function visibleAgents(userId = currentUserId()) {
  return q.all("SELECT * FROM agents WHERE archived = 0 AND (visibility = 'org' OR owner_id = ?) ORDER BY updated_at DESC", userId);
}

export function agentView(a: any, userId = currentUserId()) {
  const cfg = agentConfig(a);
  const t = q.get(`SELECT COUNT(*) n, SUM(state = 'COMPLETED') done, SUM(state NOT IN ('COMPLETED','FAILED','CANCELLED')) active, AVG(rating) rating, SUM(rating IS NOT NULL) rated FROM tasks WHERE agent_id = ?`, a.id)!;
  const owner = q.get('SELECT name FROM users WHERE id = ?', a.owner_id)?.name;
  const hist = cfg.learning?.history ?? [];
  return {
    id: a.id, name: a.name, emoji: a.emoji, color: a.color, description: a.description, instructions: a.instructions, template: a.template,
    visibility: a.visibility, ownerId: a.owner_id, ownerName: owner ?? 'Owner', mine: a.owner_id === userId, canEdit: canEditAgent(a, userId),
    plugins: cfg.plugins ?? null, tools: cfg.tools ?? null, effort: cfg.effort ?? null, criteria: cfg.criteria ?? null, starters: cfg.starters ?? [],
    sources: (cfg.sources ?? []).map((s) => ({ id: s.id, url: s.url, everyHours: s.everyHours, lastFetchedAt: s.lastFetchedAt ?? null, error: s.error ?? null })),
    study: cfg.study?.enabled ?? true, reflect: cfg.learning?.reflect ?? true,
    knowledge: kbStats(a.id),
    stats: { tasks: t.n ?? 0, completed: t.done ?? 0, active: t.active ?? 0, rating: t.rated ? Math.round(((t.rating ?? 0) + 1) * 50) : null, rated: t.rated ?? 0 },
    learning: { updates: (cfg.ranker ?? DEFAULT_RANKER).n, history: hist.slice(-30), weights: (cfg.ranker ?? DEFAULT_RANKER).w },
    createdAt: a.created_at, updatedAt: a.updated_at,
  };
}

export interface NewAgent {
  template?: string; describe?: string; name?: string; emoji?: string; color?: string; description?: string; instructions?: string;
  visibility?: 'private' | 'org'; plugins?: string[] | null; starters?: string[]; criteria?: string; sources?: string[]; notes?: string;
}

/** Draft an agent profile from a one-line description (model if available, heuristics otherwise). */
export async function draftFromDescription(describe: string): Promise<Partial<Template>> {
  const text = describe.trim();
  if (!text) throw new Permanent('Describe what the agent should do');
  if (hasReasoningModel() && getSetting('agents.draftWithModel', true)) {
    try {
      const r = await complete({
        role: 'utility', purpose: 'draft custom agent', maxTokens: 1500,
        system: 'You design specialist AI agents. Given a description, return JSON only: {"name": "2-3 word role name", "emoji": "one emoji", "description": "one sentence, what it does for the user", "instructions": "4-6 sentences: how it works, what it prioritises, what it delivers, what it must ask before doing", "starters": ["3 short example requests"], "criteria": "one sentence: what a finished task looks like"}',
        prompt: text,
      });
      const j = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1));
      if (j.name && j.instructions) return { name: String(j.name).slice(0, 40), emoji: String(j.emoji ?? '🤖').slice(0, 4), description: String(j.description ?? text).slice(0, 240), instructions: String(j.instructions).slice(0, 4000), starters: (j.starters ?? []).slice(0, 4).map(String), criteria: j.criteria ? String(j.criteria) : undefined };
    } catch { /* fall back to heuristics */ }
  }
  const tpl = TEMPLATES.map((t) => ({ t, s: overlap(text, `${t.name} ${t.description} ${t.instructions}`) })).sort((a, b) => b.s - a.s)[0];
  const words = text.replace(/^(an?|the)\s+/i, '').split(/\s+/).slice(0, 3).join(' ');
  const name = tpl.s >= 3 ? tpl.t.name : words.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/[.,;:!?]+$/, '');
  return {
    name: name.slice(0, 40), emoji: tpl.s >= 3 ? tpl.t.emoji : '🤖', description: text.slice(0, 240),
    instructions: `${text.replace(/\.?$/, '.')} ${tpl.s >= 3 ? tpl.t.instructions : 'Work carefully, verify what you deliver, and ask before anything irreversible.'}`,
    starters: tpl.s >= 3 ? tpl.t.starters : [], criteria: tpl.s >= 3 ? tpl.t.criteria : undefined,
  };
}
function overlap(a: string, b: string) { const A = new Set(a.toLowerCase().match(/[a-z]{4,}/g) ?? []); return (b.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => A.has(w)).length; }

/** One-click creation: from a template, a description, or explicit fields. Knowledge is seeded right away. */
export async function createAgent(n: NewAgent, userId = currentUserId()) {
  const tpl = n.template ? TEMPLATES.find((t) => t.id === n.template) : undefined;
  if (n.template && !tpl) throw new Permanent(`Unknown template ${n.template}`);
  const draft = !tpl && n.describe ? await draftFromDescription(n.describe) : {};
  const base: Partial<Template> = { ...tpl, ...draft };
  const name = (n.name ?? base.name ?? 'New agent').trim().slice(0, 40);
  const instructions = (n.instructions ?? base.instructions ?? n.describe ?? '').trim();
  if (!instructions) throw new Permanent('Give the agent instructions, a description, or pick a template');
  const id = uid('agt');
  const cfg: AgentConfig = {
    plugins: n.plugins ?? null, starters: n.starters ?? base.starters ?? [], criteria: n.criteria ?? base.criteria,
    sources: [], study: { enabled: true }, learning: { reflect: true, history: [] }, ranker: { ...DEFAULT_RANKER },
  };
  insert('agents', {
    id, owner_id: userId, name, emoji: n.emoji ?? base.emoji ?? '🤖', color: n.color ?? base.color ?? COLORS[q.get('SELECT COUNT(*) n FROM agents')!.n % COLORS.length],
    description: (n.description ?? base.description ?? '').slice(0, 240), instructions: instructions.slice(0, 8000), config_json: JSON.stringify(cfg),
    visibility: n.visibility ?? 'private', template: tpl?.id ?? (n.describe ? 'described' : null), created_at: now(), updated_at: now(), archived: 0,
  });
  changed('agent', id);
  activity('user', `Created the agent ${name}`, { detail: n.describe ?? tpl?.description });
  if (n.notes?.trim()) await addDocument({ agentId: id, title: 'Notes from its creator', text: n.notes, source: 'note' }).catch(() => {});
  for (const url of n.sources ?? []) await addSource(id, url, 24).catch(() => {});
  return getAgent(id)!;
}

export function updateAgent(id: string, patch: Partial<NewAgent> & { study?: boolean; reflect?: boolean; effort?: AgentConfig['effort']; tools?: string[] | null }) {
  const a = getAgent(id);
  if (!a) throw new Permanent('No such agent');
  const cfg = agentConfig(a);
  if (patch.plugins !== undefined) cfg.plugins = patch.plugins;
  if (patch.tools !== undefined) cfg.tools = patch.tools;
  if (patch.starters) cfg.starters = patch.starters.slice(0, 6);
  if (patch.criteria !== undefined) cfg.criteria = patch.criteria || undefined;
  if (patch.effort !== undefined) cfg.effort = patch.effort;
  if (patch.study !== undefined) cfg.study = { enabled: patch.study };
  if (patch.reflect !== undefined) cfg.learning = { ...(cfg.learning ?? { reflect: true }), reflect: patch.reflect };
  update('agents', id, {
    name: patch.name?.slice(0, 40), emoji: patch.emoji, color: patch.color, description: patch.description?.slice(0, 240), instructions: patch.instructions?.slice(0, 8000),
    visibility: patch.visibility, config_json: JSON.stringify(cfg), updated_at: now(),
  });
  if (patch.visibility && patch.visibility !== a.visibility) activity('user', patch.visibility === 'org' ? `Shared ${a.name} with the organization` : `Made ${a.name} private`);
  changed('agent', id);
}

export function saveConfig(id: string, fn: (c: AgentConfig) => void) {
  const a = getAgent(id);
  if (!a) return;
  const cfg = agentConfig(a);
  fn(cfg);
  update('agents', id, { config_json: JSON.stringify(cfg), updated_at: now() });
  changed('agent', id);
}

export function archiveAgent(id: string) {
  const a = getAgent(id);
  update('agents', id, { archived: 1, updated_at: now() });
  changed('agent', id, true);
  if (a) activity('user', `Archived the agent ${a.name}`);
}

/** Fork a (shared) agent into your own copy, knowledge included. */
export async function duplicateAgent(id: string, userId = currentUserId()) {
  const a = getAgent(id);
  if (!a || !canUseAgent(a, userId)) throw new Permanent('No such agent');
  const nid = uid('agt');
  const cfg = agentConfig(a);
  insert('agents', { ...a, id: nid, owner_id: userId, name: `${a.name}${a.owner_id === userId ? ' (copy)' : ''}`.slice(0, 40), visibility: 'private',
    config_json: JSON.stringify({ ...cfg, sources: (cfg.sources ?? []).map((s) => ({ ...s, docId: undefined, lastHash: undefined })) }), created_at: now(), updated_at: now() });
  for (const d of q.all("SELECT * FROM kb_documents WHERE agent_id = ? AND state = 'ready'", id)) {
    const text = q.all('SELECT text FROM kb_chunks WHERE doc_id = ? ORDER BY idx', d.id).map((c) => c.text);
    // Rebuild from passages (overlap is trimmed by re-chunking; good enough for a copy).
    await addDocument({ agentId: nid, title: d.title, text: text.join('\n\n'), source: d.source, sourceRef: d.source_ref, kind: d.kind, confidence: d.confidence }).catch(() => {});
  }
  changed('agent', nid);
  return getAgent(nid)!;
}

// ─── sources it studies ──────────────────────────────────────────────────────

export async function addSource(agentId: string, url: string, everyHours = 24) {
  const page = await fetchUrlText(url);
  const docId = await addDocument({ agentId, title: page.title, text: page.text, source: 'url', sourceRef: url });
  const src: Source = { id: uid('src'), type: 'url', url, everyHours: Math.max(1, everyHours), lastHash: page.hash, lastFetchedAt: now(), docId, error: null };
  saveConfig(agentId, (c) => { c.sources = [...(c.sources ?? []).filter((s) => s.url !== url), src]; });
  return src;
}
export function removeSource(agentId: string, sourceId: string) {
  saveConfig(agentId, (c) => { c.sources = (c.sources ?? []).filter((s) => s.id !== sourceId); });
}

/** Agents for the team chat and mentions: the custom agents this person can use. */
export function mentionableAgents(userId = currentUserId()) {
  return visibleAgents(userId).map((a) => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, description: a.description }));
}

/** Give a custom agent a piece of work. The task belongs to whoever asked, and uses their plugin connections. */
export function startAgentTask(agentId: string, o: { title?: string; goal: string; criteria?: string; spaceId?: string; attachments?: string[]; origin?: any }, userId = currentUserId()) {
  const a = getAgent(agentId);
  if (!a || !canUseAgent(a, userId)) throw new Permanent('No such agent, or it isn’t shared with you');
  const goal = o.goal.trim();
  if (!goal) throw new Permanent('Tell the agent what to do');
  const title = (o.title ?? (goal.split('\n')[0].length > 90 ? `${goal.split('\n')[0].slice(0, 87)}…` : goal.split('\n')[0])).slice(0, 120);
  const cfg = agentConfig(a);
  return createTask({
    title, goal, playbook: 'agent', agentId, ownerId: userId, spaceId: o.spaceId, origin: o.origin ?? { type: 'agent', agentId },
    input: { criteria: o.criteria?.trim() || cfg.criteria, attachments: o.attachments },
  });
}
