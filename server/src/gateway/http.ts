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
import { putSecret, deleteSecret } from '../secrets/broker.ts';
import { createDevice, setGrants, revokeDevice } from '../connectors/devices.ts';
import { modelSettings } from '../models/router.ts';
import { capabilities } from '../policy/capabilities.ts';
import { playbooks } from '../playbooks/types.ts';
import { supervisorState } from '../supervisor/supervisor.ts';
import { parseSchedule } from '../scheduler/fuzzy.ts';
import { checkNow } from '../watchers/runner.ts';

type Req = http.IncomingMessage & { body?: any; params: Record<string, string>; query: URLSearchParams };
type Handler = (req: Req, res: http.ServerResponse) => Promise<any> | any;
const routes: { method: string; re: RegExp; keys: string[]; fn: Handler }[] = [];
function route(method: string, pattern: string, fn: Handler) {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, fn });
}
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const must = (v: any, msg = 'Not found'): any => { if (v == null) throw new HttpError(404, msg); return v; };

export const authToken = process.env.AUDA_TOKEN;
export function authorized(req: http.IncomingMessage, url: URL) {
  if (!authToken) return true;
  const cookie = /(?:^|;\s*)auda_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const given = req.headers['x-auda-token'] ?? url.searchParams.get('token') ?? (cookie ? decodeURIComponent(cookie) : undefined);
  return typeof given === 'string' && given.length === authToken.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(authToken));
}

// ─── bootstrap ───────────────────────────────────────────────────────────────

route('GET', '/api/bootstrap', () => {
  const ident = q.get('SELECT * FROM identity LIMIT 1')!;
  return {
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
    conversations: q.all('SELECT id, title, channel, space_id AS spaceId, updated_at AS updatedAt FROM conversations ORDER BY updated_at DESC LIMIT 50'),
    devices: q.all('SELECT * FROM devices ORDER BY created_at DESC').map(V.deviceView),
    schedules: q.all('SELECT * FROM schedules WHERE enabled = 1 ORDER BY next_run_at').map(V.scheduleView),
    settings: V.settingsView(),
    playbooks: playbooks().map((p) => ({ id: p.id, title: p.title, description: p.description, ongoing: !!p.responsibility })),
    lastSeen: getSetting('user.lastSeen', null),
    publicUrl: config.publicUrl,
    supervisor: supervisorState,
  };
});

// ─── chat ────────────────────────────────────────────────────────────────────

route('POST', '/api/chat', async (req) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) throw new HttpError(400, 'Say something');
  const cid = ensureConversation(req.body?.conversationId, req.body?.spaceId ?? null, req.body?.channel ?? 'web');
  const reply = await handleUserMessage(cid, text, req.body?.channel ?? 'web');
  return { conversationId: cid, reply };
});
route('GET', '/api/conversations/:id/messages', (req) => q.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at', req.params.id).map(V.messageView));

// ─── work ────────────────────────────────────────────────────────────────────

route('POST', '/api/approvals/:id/decide', (req) => {
  const d = req.body?.decision;
  if (d !== 'approved' && d !== 'rejected') throw new HttpError(400, 'decision must be approved or rejected');
  return V.approvalView(must(decideApproval(req.params.id, d, req.body?.channel ?? 'web')));
});
route('GET', '/api/tasks/:id', (req) => {
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
route('POST', '/api/tasks/:id/cancel', (req) => { cancelTask(req.params.id); return { ok: true }; });
route('POST', '/api/tasks/:id/pause', (req) => { pauseTask(req.params.id); return { ok: true }; });
route('POST', '/api/tasks/:id/resume', (req) => { resumeTask(req.params.id); return { ok: true }; });
route('POST', '/api/tasks', (req) => {
  const s = req.body?.when ? parseSchedule(req.body.when) : null;
  return { id: createTask({ title: req.body.title, goal: req.body.goal, playbook: req.body.playbook ?? 'agent', input: req.body.input ?? {}, spaceId: req.body.spaceId, runAt: s?.nextRunAt, origin: { type: 'user' } }) };
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
  res.writeHead(200, { 'content-type': a.row.mime, 'content-disposition': `inline; filename="${a.row.name}"` });
  fs.createReadStream(a.abs).pipe(res);
  return undefined;
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
    'models': (x) => { const cur = getSetting<any>('models', {}); setSetting('models', { ...cur, roles: x.roles ?? cur.roles, dailyBudget: x.dailyBudget ?? cur.dailyBudget, monthlyBudget: x.monthlyBudget ?? cur.monthlyBudget, local: x.local ?? cur.local }); },
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
route('GET', '/api/health', () => ({ ok: true, supervisor: supervisorState, time: now() }));

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

// ─── server ──────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.ico': 'image/x-icon' };

export function createServer() {
  return http.createServer(async (req0, res) => {
    const req = req0 as Req;
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hooks/') || url.pathname.startsWith('/demo/')) {
        const isHook = url.pathname.startsWith('/hooks/') || url.pathname.startsWith('/demo/');
        if (!isHook && !authorized(req, url)) throw new HttpError(401, 'Unauthorized');
        const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
        if (!r) throw new HttpError(404, 'No such endpoint');
        const m = r.re.exec(url.pathname)!;
        req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        req.query = url.searchParams;
        if (req.method !== 'GET') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const raw = Buffer.concat(chunks).toString('utf8');
          (req as any).rawBody = raw;
          try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = { raw }; }
        }
        const out = await r.fn(req, res);
        if (out !== undefined && !res.headersSent) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }
        return;
      }
      // Static UI
      if (!fs.existsSync(config.webDist)) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('AUDA core is running. Build the UI with `npm run build`, or use `npm run dev`.'); return; }
      let file = path.join(config.webDist, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(config.webDist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(config.webDist, 'index.html');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log.error(`${req.method} ${url.pathname}`, e);
      if (!res.headersSent) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: (e as Error).message })); }
    }
  });
}
