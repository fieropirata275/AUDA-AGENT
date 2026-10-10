/** AUDA Gateway: REST API, inbound hooks, static UI. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../core/config.ts';
import { getSetting, now, q, setSetting, uid, insert, update } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { emit } from '../core/bus.ts';
import { activity } from '../core/activity.ts';
import { log } from '../core/log.ts';
import * as V from './views.ts';
import { ensureConversation, handleUserMessage } from '../agent/chat.ts';
import { decideApproval, cancelTask, pauseTask, resumeTask, createTask } from '../tasks/engine.ts';
import { pauseResponsibility, resumeResponsibility, endResponsibility, wakeNow, createResponsibility } from '../responsibilities/service.ts';
import { compileRule, createRule, activateRule, disableRule, deleteRule } from '../policy/rules.ts';
import { editMemory, forget, recall, remember } from '../memory/service.ts';
import { consolidate } from '../memory/consolidate.ts';
import { artifactFile } from '../artifacts/store.ts';
import { computerView, setController, controller, terminal, files, browser, services } from '../computer/index.ts';
import { connectGitHub, disconnectGitHub } from '../connectors/github.ts';
import { setConnector, CATALOG } from '../connectors/runtime.ts';
import { putSecret, deleteSecret, resolveSecret } from '../secrets/broker.ts';
import { createDevice, setGrants, revokeDevice } from '../connectors/devices.ts';
import { modelSettings } from '../models/router.ts';
import { capabilities } from '../policy/capabilities.ts';
import { playbooks } from '../playbooks/types.ts';
import { supervisorState } from '../supervisor/supervisor.ts';
import { parseSchedule } from '../scheduler/fuzzy.ts';
import { checkNow } from '../watchers/runner.ts';
import { authorize, resolveUser, requestPairing, pairingStatus, decidePairing, revokeClient } from './pairing.ts';
import { card } from './discovery.ts';
import { detect as lmDetect, connect as lmConnect, disconnect as lmDisconnect } from '../connectors/lmstudio.ts';
import { EMBEDDING_SUGGESTION, calibration as lmCalibration, downloadModel as downloadLmModel, hardware, preference as lmPreference, isLocalUrl, lmsBinary, rankModels, runSetup as runLmSetup, setupState as lmSetupState, suggest } from '../connectors/lmstudio-setup.ts';
import { listModels } from '../models/openai.ts';
import { agents, handleGroupMessage, messageAgent, saveUpload, GROUP_ID } from '../agent/group.ts';
import { system } from '../core/system.ts';
import { runAs, OWNER_ID, currentUserId } from '../core/context.ts';
import { orgEnabled, orgName, members, getUser, userView } from '../org/users.ts';
import { visiblePlugins, pluginView } from '../plugins/runtime.ts';
import { visibleAgents, agentView } from '../agents/agents.ts';
import { registerTeamRoutes } from './teamRoutes.ts';
import { busStats } from '../core/bus.ts';
import { backup, bootReport, listBackups } from '../core/db.ts';
import { browserQueue } from '../computer/browser.ts';

type Req = http.IncomingMessage & { body?: any; params: Record<string, string>; query: URLSearchParams; userId?: string };
type Handler = (req: Req, res: http.ServerResponse) => Promise<any> | any;
const routes: { method: string; re: RegExp; keys: string[]; fn: Handler; raw?: boolean; open?: boolean }[] = [];
function route(method: string, pattern: string, fn: Handler, opts: { raw?: boolean; open?: boolean } = {}) {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, fn, ...opts });
}
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const must = (v: any, msg = 'Not found'): any => { if (v == null) throw new HttpError(404, msg); return v; };

export const authToken = process.env.AUDA_TOKEN;
export function authorized(req: http.IncomingMessage, url: URL) { return authorize(req, url, authToken); }
export function userFor(req: http.IncomingMessage, url: URL) { return resolveUser(req, url, authToken); }

// ─── bootstrap ───────────────────────────────────────────────────────────────

route('GET', '/api/bootstrap', (req) => {
  const ident = q.get('SELECT * FROM identity LIMIT 1')!;
  const me = req.userId ?? OWNER_ID;
  const snap: Record<string, any> = {
    identity: V.identityView(ident),
    tasks: q.all(`SELECT * FROM tasks WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED') OR completed_at > ? ORDER BY created_at DESC LIMIT 200`, now() - 14 * 86400_000).map(V.taskView),
    responsibilities: q.all('SELECT * FROM responsibilities ORDER BY created_at DESC').map(V.respView),
    approvals: q.all("SELECT * FROM approvals WHERE state = 'pending' OR decided_at > ? ORDER BY created_at DESC LIMIT 100", now() - 7 * 86400_000).map(V.approvalView),
    rules: q.all('SELECT * FROM rules ORDER BY created_at DESC').map(V.ruleView),
    connectors: q.all('SELECT * FROM connectors').map(V.connectorView),
    catalog: CATALOG,
    computer: computerView(),
    memories: q.all('SELECT * FROM memories ORDER BY pinned DESC, updated_at DESC LIMIT 400').map(V.memoryView),
    notifications: q.all('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 80').map(V.notificationView),
    activity: q.all('SELECT * FROM activity ORDER BY ts DESC LIMIT 250').map(V.activityView),
    artifacts: q.all('SELECT * FROM artifacts ORDER BY created_at DESC LIMIT 200').map(V.artifactView),
    spaces: q.all('SELECT * FROM spaces WHERE archived = 0 ORDER BY created_at'),
    conversations: q.all("SELECT id, title, channel, space_id AS spaceId, user_id AS userId, pinned, updated_at AS updatedAt FROM conversations WHERE id != 'group' ORDER BY pinned DESC, updated_at DESC LIMIT 200"),
    devices: q.all('SELECT * FROM devices ORDER BY created_at DESC').map(V.deviceView),
    schedules: q.all('SELECT * FROM schedules WHERE enabled = 1 ORDER BY next_run_at').map(V.scheduleView),
    settings: V.settingsView(),
    playbooks: playbooks().map((p) => ({ id: p.id, title: p.title, description: p.description, ongoing: !!p.responsibility })),
    lastSeen: getSetting('user.lastSeen', null),
    publicUrl: config.publicUrl,
    supervisor: supervisorState,
    safeMode: system.safeMode,
    instance: card(),
    pairings: q.all("SELECT * FROM pairings WHERE state = 'pending' AND expires_at > ?", now()).map(V.pairingView),
    clients: q.all('SELECT * FROM clients WHERE revoked_at IS NULL ORDER BY created_at DESC').map(V.clientView),
    me: userView(getUser(me)),
    org: { enabled: orgEnabled(), name: orgName() },
    members: members(),
    plugins: visiblePlugins(me).map((p) => pluginView(p, me)),
    customAgents: visibleAgents(me).map((a) => agentView(a, me)),
  };
  // Each person sees their own work (admins supervise everything); the team room is shared.
  const entityOf: Record<string, string> = { tasks: 'task', approvals: 'approval', memories: 'memory', notifications: 'notification', activity: 'activity', artifacts: 'artifact', conversations: 'conversation', pairings: 'pairing', clients: 'client' };
  for (const [key, entity] of Object.entries(entityOf)) if (Array.isArray(snap[key])) snap[key] = snap[key].filter((d: any) => V.canSee(entity, d, me));
  return snap;
});

// ─── chat ────────────────────────────────────────────────────────────────────

route('POST', '/api/chat', async (req) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) throw new HttpError(400, 'Say something');
  const cid = ensureConversation(req.body?.conversationId, req.body?.spaceId ?? null, req.body?.channel ?? 'web');
  const reply = await handleUserMessage(cid, text, req.body?.channel ?? 'web');
  return { conversationId: cid, reply };
});
/** Rename or pin a conversation. */
route('PATCH', '/api/conversations/:id', (req) => {
  const c = q.get('SELECT id, user_id AS userId FROM conversations WHERE id = ?', req.params.id);
  if (!c || c.id === 'group' || !V.canSee('conversation', c, req.userId ?? OWNER_ID)) throw new HttpError(404, 'No such conversation');
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.title === 'string' && req.body.title.trim()) patch.title = req.body.title.trim().slice(0, 120);
  if (typeof req.body?.pinned === 'boolean') patch.pinned = req.body.pinned ? 1 : 0;
  if (Object.keys(patch).length) { update('conversations', c.id, patch); changed('conversation', c.id); }
  return V.load('conversation', c.id);
});
/** Delete a conversation, its messages, and stop any reply still being worked on. */
route('DELETE', '/api/conversations/:id', (req) => {
  const c = q.get('SELECT id, user_id AS userId FROM conversations WHERE id = ?', req.params.id);
  if (!c || c.id === 'group' || !V.canSee('conversation', c, req.userId ?? OWNER_ID)) throw new HttpError(404, 'No such conversation');
  for (const t of q.all("SELECT id FROM tasks WHERE json_extract(origin_json, '$.conversationId') = ? AND json_extract(origin_json, '$.chatRun') = 1 AND state NOT IN ('COMPLETED','FAILED','CANCELLED')", c.id)) {
    try { cancelTask(t.id, 'The conversation was deleted'); } catch { /* already finished */ }
  }
  q.run('DELETE FROM messages WHERE conversation_id = ?', c.id);
  q.run('DELETE FROM conversations WHERE id = ?', c.id);
  changed('conversation', c.id, true);
  return { ok: true };
});
route('GET', '/api/conversations/:id/messages', (req) => !V.canSee('conversation', q.get('SELECT id, user_id AS userId FROM conversations WHERE id = ?', req.params.id), req.userId ?? OWNER_ID) ? [] : q.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at', req.params.id).map(V.messageView));

// ─── work ────────────────────────────────────────────────────────────────────

/** Members act only on their own work; owners and admins on everyone's. */
function ownTask(req: Req, taskId: string | null | undefined) {
  const t = taskId ? q.get('SELECT owner_id FROM tasks WHERE id = ?', taskId) : undefined;
  if (t && !V.canSee('task', { ownerId: t.owner_id }, req.userId ?? OWNER_ID)) throw new HttpError(404, 'Not found');
}
route('POST', '/api/approvals/:id/decide', (req) => {
  ownTask(req, q.get('SELECT task_id FROM approvals WHERE id = ?', req.params.id)?.task_id);
  const d = req.body?.decision;
  if (d !== 'approved' && d !== 'rejected') throw new HttpError(400, 'decision must be approved or rejected');
  return V.approvalView(must(decideApproval(req.params.id, d, req.body?.channel ?? 'web')));
});
route('GET', '/api/tasks/:id', (req) => {
  ownTask(req, req.params.id);
  const t = must(q.get('SELECT * FROM tasks WHERE id = ?', req.params.id));
  return {
    ...V.taskView(t),
    input: (() => { const i = JSON.parse(t.input_json); delete i.previous; delete i.current; return i; })(),
    activity: q.all('SELECT * FROM activity WHERE task_id = ? ORDER BY ts', t.id).map(V.activityView),
    artifacts: q.all('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at', t.id).map(V.artifactView),
    approvals: q.all('SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at', t.id).map(V.approvalView),
    audit: q.all('SELECT * FROM audit_log WHERE task_id = ? ORDER BY ts', t.id),
    runs: q.all('SELECT attempt, state, worker_id, started_at, ended_at, outcome, error FROM task_runs WHERE task_id = ? ORDER BY started_at', t.id),
    models: q.all('SELECT role, model, input_tokens, output_tokens, cost_micro, purpose, ts FROM model_calls WHERE task_id = ? ORDER BY ts', t.id),
    stepOutputs: q.all('SELECT idx, output_json FROM task_steps WHERE task_id = ? ORDER BY idx', t.id).map((s) => ({ idx: s.idx, output: s.output_json ? JSON.parse(s.output_json) : null })),
  };
});
route('POST', '/api/tasks/:id/cancel', (req) => { ownTask(req, req.params.id); cancelTask(req.params.id); return { ok: true }; });
route('POST', '/api/tasks/:id/pause', (req) => { ownTask(req, req.params.id); pauseTask(req.params.id); return { ok: true }; });
route('POST', '/api/tasks/:id/resume', (req) => { ownTask(req, req.params.id); resumeTask(req.params.id); return { ok: true }; });
route('POST', '/api/tasks', (req) => {
  const s = req.body?.when ? parseSchedule(req.body.when) : null;
  const title = String(req.body?.title ?? '').trim();
  if (!title) throw new HttpError(400, 'Give the task a title');
  if (req.body?.when && !s) throw new HttpError(400, `I couldn’t understand “${req.body.when}” as a time`);
  const input = { ...(req.body.input ?? {}), ...(req.body.criteria ? { criteria: String(req.body.criteria) } : {}) };
  return { id: createTask({ title, goal: req.body.goal || title, playbook: req.body.playbook ?? 'agent', input, spaceId: req.body.spaceId, runAt: s?.nextRunAt, priority: req.body.priority, deadlineAt: req.body.deadlineAt, origin: { type: 'user' } }) };
});
route('POST', '/api/responsibilities', (req) => ({ id: createResponsibility({ ...req.body, origin: { type: 'user' } }) }));
route('POST', '/api/responsibilities/:id/:action', async (req) => {
  const { id, action } = req.params;
  if (action === 'pause') pauseResponsibility(id);
  else if (action === 'resume') resumeResponsibility(id);
  else if (action === 'end') endResponsibility(id);
  else if (action === 'check') { const taskId = await wakeNow(id); if (!taskId) for (const w of q.all('SELECT * FROM watchers WHERE responsibility_id = ?', id)) void checkNow(w); return { taskId }; }
  else throw new HttpError(400, 'unknown action');
  return { ok: true };
});

// ─── rules & permissions ─────────────────────────────────────────────────────

route('POST', '/api/rules', async (req) => {
  const text = String(req.body?.text ?? '').trim();
  const c = await compileRule(text);
  if (!c) throw new HttpError(422, 'I couldn’t turn that into a rule. Try naming the action: “never spend money”, “always ask before deleting files outside /tmp”.');
  return V.ruleView(q.get('SELECT * FROM rules WHERE id = ?', createRule(text, { ...c, spaceId: req.body?.spaceId, origin: 'user' }))!);
});
route('POST', '/api/rules/:id/activate', (req) => { activateRule(req.params.id); return { ok: true }; });
route('POST', '/api/rules/:id/disable', (req) => { disableRule(req.params.id); return { ok: true }; });
route('DELETE', '/api/rules/:id', (req) => { deleteRule(req.params.id); return { ok: true }; });
route('POST', '/api/permissions', (req) => {
  const { capability, level } = req.body ?? {};
  if (!capabilities[capability] || !['autonomous', 'rule', 'approval', 'deny'].includes(level)) throw new HttpError(400, 'bad permission');
  q.run("DELETE FROM permissions WHERE capability = ? AND scope_type = 'global'", capability);
  if (level !== capabilities[capability].level) insert('permissions', { id: uid('perm'), capability, scope_type: 'global', level, updated_at: now() });
  activity('user', `Changed autonomy: ${capabilities[capability].title} → ${level}`);
  changed('settings', 'settings');
  for (const c of q.all('SELECT id FROM connectors')) changed('connector', c.id);
  return { ok: true };
});

// ─── memory ──────────────────────────────────────────────────────────────────

route('GET', '/api/memories/search', (req) => recall(req.query.get('q') ?? '', { limit: 40 }).map(V.memoryView));
route('POST', '/api/memories', (req) => ({ id: remember({ ...req.body, source: 'user', confidence: 0.99, expiresAt: null }) }));
route('PATCH', '/api/memories/:id', (req) => { editMemory(req.params.id, req.body ?? {}); return { ok: true }; });
route('DELETE', '/api/memories/:id', (req) => { forget(req.params.id); return { ok: true }; });
route('POST', '/api/memory/consolidate', async () => consolidate('manual'));

// ─── activity, audit, artifacts, notifications ──────────────────────────────

route('GET', '/api/activity', (req) => {
  const before = Number(req.query.get('before') ?? now() + 1);
  return q.all('SELECT * FROM activity WHERE ts < ? ORDER BY ts DESC LIMIT 200', before).map(V.activityView);
});
route('GET', '/api/activity/:id/raw', (req) => ({ raw: JSON.parse(must(q.get('SELECT raw_json FROM activity WHERE id = ?', req.params.id)).raw_json ?? 'null') }));
route('GET', '/api/audit', () => q.all('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 300'));
route('GET', '/api/events', () => q.all('SELECT * FROM events ORDER BY created_at DESC LIMIT 300'));
route('GET', '/api/artifacts/:id/raw', (req, res) => {
  const a = must(artifactFile(req.params.id));
  const active = /html|svg|xml|javascript/.test(a.row.mime);
  res.writeHead(200, {
    'content-type': a.row.mime, 'x-content-type-options': 'nosniff',
    'content-disposition': `${req.query.get('download') ? 'attachment' : 'inline'}; filename="${encodeURIComponent(a.row.name)}"`,
    // Agent-made HTML/SVG runs in an opaque, sandboxed origin: it can't read AUDA's cookies or call its API.
    ...(active ? { 'content-security-policy': "sandbox allow-scripts allow-popups; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; media-src data:" } : {}),
  });
  fs.createReadStream(a.abs).pipe(res);
  return undefined;
});
/** What the UI needs to show an artifact well: text/tables for Office files, and its sibling formats. */
route('GET', '/api/artifacts/:id/preview', async (req) => {
  const a = must(artifactFile(req.params.id));
  const ext = path.extname(a.row.name).toLowerCase();
  const base = a.row.name.slice(0, a.row.name.length - ext.length);
  const siblings = a.row.task_id ? q.all('SELECT id, name, mime FROM artifacts WHERE task_id = ? AND id != ? ORDER BY created_at', a.row.task_id, a.row.id).filter((x) => x.name.startsWith(`${base}.`)) : [];
  if (ext === '.xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(a.abs);
    const sheets = wb.worksheets.map((ws) => ({ name: ws.name, rowCount: ws.rowCount, rows: (ws.getSheetValues() as any[]).slice(1, 201).map((r) => Array.from((r ?? []).slice(1), (v: any) => v && typeof v === 'object' ? ('formula' in v ? `=${v.formula}` : v instanceof Date ? v.toISOString().slice(0, 10) : 'text' in v ? v.text : 'richText' in v ? v.richText.map((x: any) => x.text).join('') : '') : v ?? '')) }));
    return { kind: 'spreadsheet', sheets, siblings };
  }
  if (['.pptx', '.docx', '.pdf'].includes(ext)) {
    const { readDocument } = await import('../office/documents.ts');
    const r = await readDocument(a.abs, 60_000).catch((e) => ({ text: `Couldn't read: ${(e as Error).message}`, kind: 'error', pages: undefined }));
    return { kind: r.kind, text: r.text, pages: r.pages, siblings };
  }
  return { kind: 'file', siblings };
});
route('POST', '/api/notifications/read', () => { q.run('UPDATE notifications SET read_at = ? WHERE read_at IS NULL', now()); for (const n of q.all('SELECT id FROM notifications ORDER BY created_at DESC LIMIT 80')) changed('notification', n.id); return { ok: true }; });

// ─── computer ────────────────────────────────────────────────────────────────

route('GET', '/api/computer', () => ({ ...computerView(), transcript: terminal.transcript() }));
route('GET', '/api/computer/fs', (req) => {
  const p = req.query.get('path') ?? '~';
  return { path: p, entries: files.list(p), artifacts: q.all('SELECT id, path, why, task_id FROM artifacts').filter((a) => a.path.startsWith(p.replace(/\/$/, '') + '/')) };
});
route('GET', '/api/computer/file', (req) => {
  const p = req.query.get('path')!;
  const art = q.get('SELECT * FROM artifacts WHERE path = ?', p);
  return { ...files.read(p, 120_000), artifact: art ? V.artifactView(art) : null };
});
route('POST', '/api/computer/control', (req) => { setController(req.body?.who === 'human' ? 'human' : 'auda'); return computerView(); });
const requireHuman = () => { if (controller() !== 'human') throw new HttpError(409, 'Take control of AUDA’s computer first'); };
route('POST', '/api/computer/terminal', async (req) => {
  requireHuman();
  const r = await terminal.run(String(req.body?.cmd ?? ''), { actor: 'human' });
  insert('audit_log', { id: uid('aud'), ts: now(), actor: 'user', capability: 'terminal', target: req.body?.cmd, decision: 'user', result: r.code === 0 ? 'ok' : 'error', detail: `exit ${r.code}` });
  return r;
});
route('POST', '/api/computer/browser', async (req) => { requireHuman(); await browser.humanInput(req.body ?? {}); return { ok: true }; });
route('POST', '/api/computer/browser/hang', () => {
  const ok = browser.hangForDemo();
  if (ok) activity('user', 'You froze AUDA’s browser to test recovery', { detail: 'The supervisor should notice within ~10 seconds.' });
  return { ok };
});
route('POST', '/api/computer/browser/open', async () => { await browser.ensure(); return browser.status(); });
route('POST', '/api/computer/services/:name/:action', async (req) => {
  const { name, action } = req.params;
  if (action === 'start') services.start(name);
  else if (action === 'stop') await services.stop(name);
  else if (action === 'restart') await services.restart(name);
  else if (action === 'configure') services.configure(name, req.body.key, req.body.value);
  else throw new HttpError(400, 'unknown action');
  const label = action === 'configure' ? `set ${name} ${req.body.key} to ${req.body.value}` : `${action === 'stop' ? 'stopped' : action + 'ed'} ${name}`;
  activity('user', `You ${label}`, { detail: 'A change made by you on AUDA’s computer.' });
  terminal.note(`you ${label}`, 'human');
  changed('computer', 'computer');
  return services.status(name);
});

// ─── connectors & settings ───────────────────────────────────────────────────

route('POST', '/api/connectors/github', async (req) => {
  const r = await connectGitHub(String(req.body?.token ?? '').trim()).catch((e) => { throw new HttpError(400, e.message); });
  activity('user', `Connected GitHub as @${r.login}`, { detail: 'Reading is autonomous; re-running CI follows your rules; commenting always asks.' });
  return r;
});
route('DELETE', '/api/connectors/github', () => { disconnectGitHub(); activity('user', 'Disconnected GitHub'); return { ok: true }; });
route('POST', '/api/connectors/anthropic', async (req) => {
  const key = String(req.body?.key ?? '').trim();
  const res = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res || !res.ok) throw new HttpError(400, res?.status === 401 ? 'Anthropic rejected that key' : 'Couldn’t reach Anthropic to verify the key');
  const m = modelSettings();
  if (m.anthropicSecret) deleteSecret(m.anthropicSecret);
  setSetting('models', { ...getSetting<any>('models', {}), anthropicSecret: putSecret('anthropic-key', key) });
  setConnector('anthropic', { state: 'connected', detail: 'Reasoning, summaries and rule compilation', error: null, last_ok_at: now() });
  activity('user', 'Connected Claude', { detail: 'AUDA can now take on open-ended work. The key is encrypted and never shown to a model.' });
  changed('settings', 'settings');
  return { ok: true };
});
route('DELETE', '/api/connectors/anthropic', () => {
  const m = modelSettings();
  if (m.anthropicSecret) deleteSecret(m.anthropicSecret);
  setSetting('models', { ...getSetting<any>('models', {}), anthropicSecret: undefined });
  setConnector('anthropic', { state: process.env.ANTHROPIC_API_KEY ? 'connected' : 'disconnected', detail: process.env.ANTHROPIC_API_KEY ? 'Using ANTHROPIC_API_KEY from the environment' : null });
  changed('settings', 'settings');
  return { ok: true };
});
route('PUT', '/api/settings/:key', (req) => {
  const { key } = req.params;
  const v = req.body?.value;
  const allowed: Record<string, (v: any) => void> = {
    'notifications.prefs': (x) => setSetting('notifications.prefs', x),
    'notifications.webhook': (x) => setSetting('notifications.webhook', String(x ?? '')),
    'ui.sound': (x) => setSetting('ui.sound', !!x),
    'engine.concurrency': (x) => setSetting('engine.concurrency', Math.max(1, Math.min(8, Number(x)))),
    'agent.verify': (x) => setSetting('agent.verify', !!x),
    'agent.webSearch': (x) => setSetting('agent.webSearch', !!x),
    'models': (x) => { const cur = getSetting<any>('models', {}); setSetting('models', { ...cur, roles: x.roles ?? cur.roles, dailyBudget: x.dailyBudget ?? cur.dailyBudget, monthlyBudget: x.monthlyBudget ?? cur.monthlyBudget, local: x.local ?? cur.local }); },
    'instance.name': (x) => setSetting('instance.name', String(x).slice(0, 60)),
    'security.requirePairing': (x) => setSetting('security.requirePairing', !!x),
    'identity': (x) => { const id = q.get('SELECT id FROM identity LIMIT 1')!.id; update('identity', id, { user_name: x.userName }); changed('identity', id); },
  };
  if (!allowed[key]) throw new HttpError(400, 'unknown setting');
  allowed[key](v);
  changed('settings', 'settings');
  return V.settingsView();
});
route('POST', '/api/devices', (req) => {
  const d = createDevice(String(req.body?.name ?? 'My computer'));
  return { ...d, command: `node scripts/auda-link.mjs --server ${config.publicUrl.replace(/^http/, 'ws')} --token ${d.token}` };
});
route('POST', '/api/devices/:id/grants', (req) => { setGrants(req.params.id, req.body ?? {}); return { ok: true }; });
route('DELETE', '/api/devices/:id', (req) => { revokeDevice(req.params.id); return { ok: true }; });
route('POST', '/api/spaces', (req) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) throw new HttpError(400, 'name required');
  const id = uid('space');
  insert('spaces', { id, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + id.slice(-4), description: req.body?.description, icon: req.body?.icon, created_at: now() });
  changed('space', id);
  return { id };
});
// ─── discovery, pairing, clients ─────────────────────────────────────────────

route('GET', '/api/discover', () => card(), { open: true });
route('POST', '/api/pair/request', (req) => {
  try { return requestPairing(String(req.body?.name ?? 'Phone'), req.body?.platform); } catch (e) { throw new HttpError(429, (e as Error).message); }
}, { open: true });
route('GET', '/api/pair/:id', (req) => {
  try { return pairingStatus(req.params.id, req.query.get('secret') ?? ''); } catch (e) { throw new HttpError(404, (e as Error).message); }
}, { open: true });
route('POST', '/api/pair/:id/:decision', (req) => {
  try { decidePairing(req.params.id, req.params.decision === 'approve'); } catch (e) { throw new HttpError(409, (e as Error).message); }
  return { ok: true };
});
route('GET', '/api/pairings', () => q.all("SELECT id, name, platform, code, state, created_at AS createdAt, expires_at AS expiresAt FROM pairings WHERE state = 'pending' AND expires_at > ?", now()));
route('GET', '/api/clients', () => q.all('SELECT id, name, platform, created_at AS createdAt, last_seen_at AS lastSeenAt FROM clients WHERE revoked_at IS NULL ORDER BY created_at DESC'));
route('DELETE', '/api/clients/:id', (req) => { revokeClient(req.params.id); return { ok: true }; });

// ─── LM Studio / local models ────────────────────────────────────────────────

route('GET', '/api/lmstudio/detect', async () => ({ found: await lmDetect(), configured: modelSettings().local ?? null }));
route('GET', '/api/lmstudio/models', async (req) => listModels(String(req.query.get('baseUrl') ?? modelSettings().local?.baseUrl ?? 'http://127.0.0.1:1234')).catch((e) => { throw new HttpError(502, `Couldn’t reach that server: ${(e as Error).message}`); }));
route('POST', '/api/lmstudio/connect', async (req) => {
  const { baseUrl, model, roles, apiKey } = req.body ?? {};
  if (!baseUrl || !model) throw new HttpError(400, 'Choose a server and a model');
  try { return await lmConnect({ baseUrl, model, roles: Array.isArray(roles) && roles.length ? roles : ['reasoning', 'utility', 'coding', 'vision'], apiKey }); }
  catch (e) { throw new HttpError(400, (e as Error).message); }
});
route('DELETE', '/api/lmstudio', () => { lmDisconnect(); activity('user', 'Disconnected LM Studio'); return { ok: true }; });
/** Everything setup needs to decide: this machine, the CLI, servers found, models ranked for this machine, downloads that fit. */
route('GET', '/api/lmstudio/doctor', async (req) => {
  const found = await lmDetect();
  const baseUrl = String(req.query.get('baseUrl') ?? modelSettings().local?.baseUrl ?? (found.find((f) => f.flavor === 'lmstudio') ?? found[0])?.baseUrl ?? '');
  const hw = !baseUrl || isLocalUrl(baseUrl) ? await hardware(req.query.get('refresh') === '1') : null;
  const pref = (['fast', 'balanced', 'smart'].includes(String(req.query.get('preference'))) ? req.query.get('preference') : lmPreference()) as any;
  let models: any[] = [], api: string | null = null, error: string | null = null;
  if (baseUrl) {
    try { const r = await listModels(baseUrl, resolveSecret(modelSettings().local?.apiKeySecret)); models = r.models; api = r.api; }
    catch (e) { error = (e as Error).message; }
  }
  return { baseUrl: baseUrl || null, api, error, hardware: hw, lms: lmsBinary(), local: baseUrl ? isLocalUrl(baseUrl) : true, found: found.map((f) => ({ baseUrl: f.baseUrl, flavor: f.flavor, models: f.models.length })), models, ranked: rankModels(models, hw, pref), suggestions: suggest(hw, pref), preference: pref, calibration: lmCalibration(), embedding: EMBEDDING_SUGGESTION, hasEmbeddings: models.some((m) => m.type === 'embeddings'), setup: lmSetupState(), platform: process.platform };
});
/** One click: find/start the server, (download,) pick, load with a real context, probe, measure, connect. Progress arrives on the settings feed. */
route('POST', '/api/lmstudio/setup', (req) => {
  const { baseUrl, model, download, apiKey, roles, preference } = req.body ?? {};
  void runLmSetup({ baseUrl: baseUrl || undefined, model: model || undefined, download: download || undefined, apiKey: apiKey || undefined, roles: Array.isArray(roles) ? roles : undefined, preference: ['fast', 'balanced', 'smart'].includes(preference) ? preference : undefined }).then((r) => {
    if (r.outcome === 'connected' || r.outcome === 'text-only') activity('user', `Set up LM Studio: ${r.result!.model}`, { detail: r.message });
  });
  return { started: true };
});
route('POST', '/api/lmstudio/preference', (req) => {
  const p = req.body?.preference;
  if (!['fast', 'balanced', 'smart'].includes(p)) throw new HttpError(400, 'Choose fast, balanced or smart');
  setSetting('lmstudio.preference', p); changed('settings', 'settings');
  return { preference: p };
});
route('POST', '/api/lmstudio/download-embeddings', async () => {
  const l = modelSettings().local;
  if (!l?.baseUrl) throw new HttpError(400, 'Connect LM Studio first');
  try {
    await downloadLmModel(l.baseUrl, EMBEDDING_SUGGESTION.key, () => undefined);
    const m = (await listModels(l.baseUrl, resolveSecret(l.apiKeySecret))).models.find((x) => x.type === 'embeddings');
    if (m) { setSetting('kb.embedModel', m.id); changed('settings', 'settings'); }
    activity('user', `Agents now search knowledge with ${m?.id ?? EMBEDDING_SUGGESTION.name}`);
    return { model: m?.id ?? null };
  } catch (e) { throw new HttpError(400, (e as Error).message); }
});

// ─── group chat, agents, files ───────────────────────────────────────────────

route('GET', '/api/agents', () => agents());
route('GET', '/api/group/messages', (req) => {
  const before = Number(req.query.get('before') ?? now() + 1);
  return q.all('SELECT * FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 150', GROUP_ID, before).reverse().map(V.messageView);
});
route('POST', '/api/group', async (req) => {
  for (const m of req.body?.mentions ?? []) if (typeof m === 'string' && m.startsWith('task_')) ownTask(req, m);
  try { return await handleGroupMessage({ text: String(req.body?.text ?? ''), attachments: req.body?.attachments, mentions: req.body?.mentions, channel: req.body?.channel ?? 'web', from: req.body?.from }); }
  catch (e) { throw new HttpError(400, (e as Error).message); }
});
route('POST', '/api/tasks/:id/message', (req) => {
  ownTask(req, req.params.id);
  try { return messageAgent(req.params.id, String(req.body?.text ?? ''), req.body?.attachments ?? []); } catch (e) { throw new HttpError(404, (e as Error).message); }
});
route('POST', '/api/files', async (req) => {
  const name = req.query.get('name') ?? String(req.headers['x-filename'] ?? 'file');
  try { return await saveUpload(req, { name: decodeURIComponent(name), dir: req.query.get('dir') ?? undefined, from: req.query.get('from') ?? undefined }); }
  catch (e) { throw new HttpError(413, (e as Error).message); }
}, { raw: true });
route('GET', '/api/computer/download', (req, res) => {
  const p = req.query.get('path') ?? '';
  const abs = files.resolveWs(p);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw new HttpError(404, 'No such file');
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${path.basename(abs)}"`, ...CORS });
  fs.createReadStream(abs).pipe(res);
  return undefined;
});

route('GET', '/api/health', () => ({ ok: true, pid: process.pid, safeMode: system.safeMode, rssMb: Math.round(process.memoryUsage().rss / 1048576), loopLagMs: system.loopLagMs, time: now() }), { open: true }); // the supervisor's watchdog must reach it without signing in
route('GET', '/api/system', () => ({
  ...system, uptimeMs: now() - system.startedAt, rssMb: Math.round(process.memoryUsage().rss / 1048576), heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
  supervisor: supervisorState, bus: busStats, boot: bootReport, backups: listBackups().slice(0, 12), browserQueue: browserQueue.waiting,
  quarantined: q.all("SELECT id, title, diagnosis, completed_at FROM tasks WHERE error = 'Quarantined after repeated crashes' ORDER BY completed_at DESC LIMIT 10"),
  recentRecoveries: q.get("SELECT COUNT(*) n FROM activity WHERE kind = 'recover' AND ts > ?", now() - 86400_000)!.n,
  failedToday: q.get("SELECT COUNT(*) n FROM tasks WHERE state = 'FAILED' AND completed_at > ?", now() - 86400_000)!.n,
  pendingEvents: q.get('SELECT COUNT(*) n FROM events WHERE dispatched = 0')!.n,
}));
route('POST', '/api/system/backup', () => { system.lastBackup = backup(); activity('user', 'You made a backup', { detail: system.lastBackup }); return { name: system.lastBackup }; });
route('POST', '/api/system/leave-safe-mode', () => {
  if (!system.safeMode) return { ok: true };
  if (!system.supervised) throw new HttpError(409, 'Restart AUDA without AUDA_SAFE_MODE to leave safe mode.');
  activity('user', 'You asked AUDA to leave safe mode');
  setTimeout(() => process.exit(75), 300);
  return { ok: true, restarting: true };
});

// ─── inbound hooks ───────────────────────────────────────────────────────────

route('POST', '/hooks/github', (req) => {
  const secret = getSetting<string>('github.webhookSecret', '');
  if (secret) {
    const sig = String(req.headers['x-hub-signature-256'] ?? '');
    const expect = 'sha256=' + crypto.createHmac('sha256', secret).update((req as any).rawBody ?? '').digest('hex');
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) throw new HttpError(401, 'bad signature');
  }
  const ev = req.headers['x-github-event'];
  const b = req.body ?? {};
  if (ev === 'workflow_run' && b.action === 'completed' && ['failure', 'timed_out'].includes(b.workflow_run?.conclusion)) {
    emit('connector.github.workflow_failed', { source: 'github', payload: { repo: b.repository?.full_name, runId: b.workflow_run.id, runName: b.workflow_run.name, branch: b.workflow_run.head_branch, url: b.workflow_run.html_url } });
  }
  return { ok: true };
});
route('POST', '/hooks/:slug', (req) => {
  const e = emit('connector.webhook.received', { source: 'webhook', payload: { slug: req.params.slug, body: req.body ?? {} } });
  activity('observe', `Webhook received: ${req.params.slug}`, { detail: JSON.stringify(req.body ?? {}).slice(0, 300) });
  return { ok: true, event: e.id };
});

// A small page AUDA can watch out of the box (and tests can change).
let demoPage = { title: 'Northwind Parts — Lead times', rows: [['M8 hex standoffs', 'In stock', '2 days'], ['6061 plate 4mm', 'In stock', '5 days'], ['NEMA17 motors', 'Backordered', '3 weeks']] as string[][] };
route('GET', '/demo/supplier', (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset=utf-8><title>${demoPage.title}</title><body style="font:16px system-ui;max-width:640px;margin:40px auto;color:#222"><h1>${demoPage.title}</h1><p>Demo supplier page served by AUDA for testing watchers.</p><table cellpadding=8>${demoPage.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></body>`);
  return undefined;
});
route('POST', '/api/demo/supplier', (req) => { demoPage = { ...demoPage, ...req.body }; return demoPage; });

registerTeamRoutes(route, HttpError);

// ─── server ──────────────────────────────────────────────────────────────────

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-auda-token, authorization', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.ico': 'image/x-icon' };

export function createServer() {
  return http.createServer(async (req0, res) => {
    const req = req0 as Req;
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hooks/') || url.pathname.startsWith('/demo/')) {
        const isHook = url.pathname.startsWith('/hooks/') || url.pathname.startsWith('/demo/');
        if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
        const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
        const userId = userFor(req, url);
        if (!isHook && !r?.open && !userId) throw new HttpError(401, orgEnabled() ? 'Sign in to continue' : 'Unauthorized — pair this device first');
        if (!r) throw new HttpError(404, 'No such endpoint');
        req.userId = userId ?? undefined;
        const m = r.re.exec(url.pathname)!;
        req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        req.query = url.searchParams;
        if (req.method !== 'GET' && !r.raw) {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const raw = Buffer.concat(chunks).toString('utf8');
          (req as any).rawBody = raw;
          try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = { raw }; }
        }
        const out = await runAs(userId ?? OWNER_ID, () => r.fn(req, res));
        if (out !== undefined && !res.headersSent) { res.writeHead(200, { 'content-type': 'application/json', ...CORS }); res.end(JSON.stringify(out)); }
        return;
      }
      // Static UI
      if (!fs.existsSync(config.webDist)) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('AUDA core is running. Build the UI with `npm run build`, or use `npm run dev`.'); return; }
      let file = path.join(config.webDist, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(config.webDist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(config.webDist, 'index.html');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': url.pathname.startsWith('/assets/') && !file.endsWith('index.html') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log.error(`${req.method} ${url.pathname}`, e);
      if (!res.headersSent) { res.writeHead(status, { 'content-type': 'application/json', ...CORS }); res.end(JSON.stringify({ error: (e as Error).message })); }
    }
  });
}
