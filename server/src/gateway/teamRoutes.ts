/** Routes for the organization, plugins, custom agents and their knowledge. Registered by http.ts. */
import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { q } from '../core/db.ts';
import { OWNER_ID } from '../core/context.ts';
import { activity } from '../core/activity.ts';
import { config } from '../core/config.ts';
import * as Org from '../org/users.ts';
import * as P from '../plugins/runtime.ts';
import { PRESETS } from '../plugins/presets.ts';
import * as A from '../agents/agents.ts';
import * as K from '../agents/knowledge.ts';
import * as L from '../agents/learning.ts';
import { Permanent } from '../tools/errors.ts';

type Req = http.IncomingMessage & { body?: any; params: Record<string, string>; query: URLSearchParams; userId?: string };
type Route = (method: string, pattern: string, fn: (req: Req, res: http.ServerResponse) => any, opts?: { raw?: boolean; open?: boolean }) => void;
type HttpErrorCtor = new (status: number, msg: string) => Error;

const SECURE = config.publicUrl.startsWith('https://');
function setSession(res: http.ServerResponse, token: string | null) {
  res.setHeader('set-cookie', token
    ? `auda_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${SECURE ? '; Secure' : ''}`
    : `auda_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE ? '; Secure' : ''}`);
}

// Login throttling: 10 attempts per address per 5 minutes.
const attempts = new Map<string, { n: number; since: number }>();
function throttle(req: http.IncomingMessage, Err: HttpErrorCtor) {
  const ip = req.socket.remoteAddress ?? '?';
  const a = attempts.get(ip);
  const now = Date.now();
  if (!a || now - a.since > 5 * 60_000) { attempts.set(ip, { n: 1, since: now }); return; }
  if (++a.n > 10) throw new Err(429, 'Too many attempts. Wait a few minutes and try again.');
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function registerTeamRoutes(route: Route, HttpError: HttpErrorCtor) {
  const uid = (req: Req) => req.userId ?? OWNER_ID;
  const wrap = async <T>(fn: () => T | Promise<T>, status = 400): Promise<T> => {
    try { return await fn(); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(status, (e as Error).message); }
  };
  const admin = (req: Req) => { if (!Org.isAdmin(uid(req))) throw new HttpError(403, 'Only owners and admins can do that'); };

  // ─── accounts ──────────────────────────────────────────────────────────────

  route('GET', '/api/auth/me', (req) => ({
    org: { enabled: Org.orgEnabled(), name: Org.orgName() },
    user: req.userId ? Org.userView(Org.getUser(req.userId)) : null,
    needsLogin: Org.orgEnabled() && !req.userId,
  }), { open: true });
  route('POST', '/api/auth/login', (req, res) => wrap(() => {
    throttle(req, HttpError);
    const u = Org.login(String(req.body?.email ?? ''), String(req.body?.password ?? ''));
    const token = Org.createSession(u.id, String(req.headers['user-agent'] ?? ''));
    setSession(res, token);
    return { token, user: Org.userView(u) };
  }, 401), { open: true });
  route('POST', '/api/auth/logout', (req, res) => {
    const t = Org.tokenFrom(req, new URL(req.url ?? '/', 'http://x'));
    if (t?.startsWith('sess_')) Org.endSession(t);
    setSession(res, null);
    return { ok: true };
  }, { open: true });

  route('POST', '/api/org/setup', (req, res) => wrap(() => {
    if (uid(req) !== OWNER_ID) throw new HttpError(403, 'Only the owner can set up the organization');
    if (Org.orgEnabled()) throw new HttpError(409, 'The organization is already set up');
    Org.setupOrganization({ orgName: String(req.body?.orgName ?? ''), ownerName: String(req.body?.name ?? ''), email: String(req.body?.email ?? ''), password: String(req.body?.password ?? '') });
    const token = Org.createSession(OWNER_ID, String(req.headers['user-agent'] ?? ''));
    setSession(res, token);
    return { token, user: Org.userView(Org.getUser(OWNER_ID)) };
  }));
  route('GET', '/api/org/members', (req) => ({
    org: { enabled: Org.orgEnabled(), name: Org.orgName() },
    members: Org.members(),
    invites: Org.isAdmin(uid(req)) ? q.all('SELECT id, email, role, created_at AS createdAt, expires_at AS expiresAt FROM invites WHERE used_by IS NULL AND expires_at > ? ORDER BY created_at DESC', Date.now()) : [],
  }));
  route('POST', '/api/org/invites', (req) => wrap(() => {
    if (!Org.orgEnabled()) throw new HttpError(409, 'Set up the organization first');
    return Org.createInvite(uid(req), req.body?.role === 'admin' ? 'admin' : 'member', req.body?.email || undefined);
  }));
  route('DELETE', '/api/org/invites/:id', (req) => { admin(req); q.run('DELETE FROM invites WHERE id = ? AND used_by IS NULL', req.params.id); return { ok: true }; });
  route('PATCH', '/api/org/members/:id', (req) => wrap(() => { Org.setRole(uid(req), req.params.id, req.body?.role); return Org.userView(Org.getUser(req.params.id)); }));
  route('DELETE', '/api/org/members/:id', (req) => wrap(() => { Org.removeMember(uid(req), req.params.id); return { ok: true }; }));
  route('GET', '/api/join/:code', (req) => wrap(() => Org.inviteInfo(req.params.code), 404), { open: true });
  route('POST', '/api/join', (req, res) => wrap(() => {
    throttle(req, HttpError);
    const u = Org.acceptInvite(String(req.body?.code ?? ''), { name: String(req.body?.name ?? ''), email: String(req.body?.email ?? ''), password: String(req.body?.password ?? '') });
    const token = Org.createSession(u!.id, String(req.headers['user-agent'] ?? ''));
    setSession(res, token);
    return { token, user: Org.userView(u) };
  }), { open: true });

  // ─── plugins ───────────────────────────────────────────────────────────────

  const plugin = (req: Req, manage = false) => {
    const p = P.getPlugin(req.params.id);
    if (!p || (p.visibility === 'private' && p.createdBy !== uid(req) && !Org.isAdmin(uid(req)))) throw new HttpError(404, 'No such plugin');
    if (manage && !P.canManage(p, uid(req))) throw new HttpError(403, 'Only whoever added this plugin, or an admin, can change it');
    return p;
  };
  route('GET', '/api/plugins', (req) => ({
    plugins: P.visiblePlugins(uid(req)).map((p) => P.pluginView(p, uid(req))),
    presets: PRESETS.map((p) => ({ id: p.id, name: p.name, icon: p.icon, description: p.description, kind: p.kind, setup: p.setup, auth: p.config.auth.type, tools: p.config.tools.length })),
    redirectUri: P.redirectUri(),
  }));
  route('POST', '/api/plugins', (req) => wrap(async () => {
    const vis = req.body?.visibility ?? (Org.isAdmin(uid(req)) ? 'org' : 'private');
    const p = await P.createPlugin({ ...req.body, visibility: vis }, uid(req));
    return P.pluginView(p, uid(req));
  }));
  route('PATCH', '/api/plugins/:id', (req) => wrap(() => { P.updatePlugin(plugin(req, true).id, req.body ?? {}); return P.pluginView(P.getPlugin(req.params.id)!, uid(req)); }));
  route('DELETE', '/api/plugins/:id', (req) => { P.deletePlugin(plugin(req, true).id); return { ok: true }; });
  route('POST', '/api/plugins/:id/connect', (req) => wrap(() => P.startConnect(plugin(req).id, uid(req), req.body?.returnTo)));
  route('POST', '/api/plugins/:id/key', (req) => wrap(() => { P.saveKey(plugin(req).id, String(req.body?.key ?? ''), uid(req)); return P.pluginView(P.getPlugin(req.params.id)!, uid(req)); }));
  route('POST', '/api/plugins/:id/disconnect', (req) => { P.disconnect(plugin(req).id, uid(req)); return { ok: true }; });
  route('POST', '/api/plugins/:id/refresh-tools', (req) => wrap(async () => ({ tools: (await P.refreshMcpTools(plugin(req).id, uid(req))).length })));
  route('POST', '/api/plugins/:id/test', (req) => wrap(async () => {
    const p = plugin(req);
    const t = P.findTool(p, String(req.body?.tool ?? '')) ?? p.config.tools.find((x) => x.readOnly);
    if (!t) throw new HttpError(400, 'No read-only tool to test with');
    if (!t.readOnly) throw new HttpError(400, 'Only read-only tools can be tested from here');
    const r = await P.callTool(p.id, t.name, req.body?.args ?? {}, uid(req));
    return { tool: t.name, status: r.status, preview: r.text.slice(0, 2000) };
  }));
  // The provider redirects the browser here; the signed-in user is identified by the one-time state.
  route('GET', '/api/oauth/callback', async (req, res) => {
    const r = await P.finishOAuth(String(req.query.get('state') ?? ''), req.query.get('code'), req.query.get('error_description') ?? req.query.get('error'));
    const back = r.returnTo && /^\/(?!\/|\\)[^\r\n]*$/.test(r.returnTo) ? r.returnTo : '/plugins';
    res.writeHead(r.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(r.plugin)}</title>
<body style="font:16px system-ui;display:grid;place-items:center;min-height:90vh;margin:0;background:#f4f1ec;color:#222">
<div style="max-width:420px;padding:28px;border-radius:20px;background:#fff;box-shadow:0 10px 40px #0002;text-align:center">
<div style="font-size:40px">${r.ok ? '✓' : '!'}</div><h2 style="margin:8px 0">${r.ok ? `${esc(r.plugin)} connected` : 'Not connected'}</h2><p>${esc(r.message)}</p>
<p><a href="${esc(back)}">Back to AUDA</a></p></div>
<script>try{window.opener&&window.opener.postMessage({type:'auda-oauth',ok:${r.ok}},location.origin)}catch(e){}${r.ok ? 'setTimeout(function(){window.opener?window.close():location.href=' + JSON.stringify(back) + '},1200)' : ''}</script>`);
    return undefined;
  }, { open: true });

  // ─── custom agents ─────────────────────────────────────────────────────────

  const agent = (req: Req, edit = false) => {
    const a = A.getAgent(req.params.id);
    if (!a || !A.canUseAgent(a, uid(req))) throw new HttpError(404, 'No such agent');
    if (edit && !A.canEditAgent(a, uid(req))) throw new HttpError(403, 'Only its owner (or an admin) can change this agent — duplicate it to make your own version');
    return a;
  };
  route('GET', '/api/custom-agents', (req) => ({
    agents: A.visibleAgents(uid(req)).map((a) => A.agentView(a, uid(req))),
    templates: A.TEMPLATES.map((t) => ({ id: t.id, name: t.name, emoji: t.emoji, color: t.color, description: t.description })),
  }));
  route('POST', '/api/custom-agents', (req) => wrap(async () => A.agentView(await A.createAgent(req.body ?? {}, uid(req)), uid(req))));
  route('GET', '/api/custom-agents/:id', (req) => {
    const a = agent(req);
    return { ...A.agentView(a, uid(req)), documents: K.documents(a.id),
      recentTasks: q.all('SELECT id, title, state, rating, completed_at AS completedAt, owner_id AS ownerId FROM tasks WHERE agent_id = ? AND parent_task_id IS NULL AND (owner_id = ? OR ?) ORDER BY created_at DESC LIMIT 20', a.id, uid(req), Org.isAdmin(uid(req)) ? 1 : 0) };
  });
  route('PATCH', '/api/custom-agents/:id', (req) => wrap(() => { A.updateAgent(agent(req, true).id, req.body ?? {}); return A.agentView(A.getAgent(req.params.id), uid(req)); }));
  route('DELETE', '/api/custom-agents/:id', (req) => { A.archiveAgent(agent(req, true).id); return { ok: true }; });
  route('POST', '/api/custom-agents/:id/duplicate', (req) => wrap(async () => A.agentView(await A.duplicateAgent(agent(req).id, uid(req)), uid(req))));
  route('POST', '/api/custom-agents/:id/run', (req) => wrap(() => ({ id: A.startAgentTask(agent(req).id, { goal: String(req.body?.goal ?? ''), title: req.body?.title, criteria: req.body?.criteria, spaceId: req.body?.spaceId, attachments: req.body?.attachments }, uid(req)) })));
  route('GET', '/api/custom-agents/:id/search', (req) => wrap(async () => (await K.search(agent(req).id, String(req.query.get('q') ?? ''), { k: 8, log: false, minScore: 0 }))
    .map((h) => ({ title: h.title, kind: h.kind, text: h.text.slice(0, 600), score: Math.round(h.score * 100) / 100, features: Object.fromEntries(K.FEATURES.map((f, i) => [f, h.features[i]])) }))));
  route('POST', '/api/custom-agents/:id/knowledge', (req) => wrap(async () => {
    const a = agent(req, true);
    const b = req.body ?? {};
    if (b.type === 'url' || (b.url && !b.type)) {
      const s = await A.addSource(a.id, String(b.url), Number(b.everyHours ?? 24));
      return { ok: true, source: s.id };
    }
    if (b.type === 'path') {
      const { resolveWs } = await import('../computer/files.ts');
      const abs = resolveWs(String(b.path));
      const files = fs.statSync(abs).isDirectory() ? walk(abs).slice(0, 200) : [abs];
      const added: string[] = []; const failed: string[] = [];
      for (const f of files) {
        try { added.push(await K.addDocument({ agentId: a.id, title: path.basename(f), text: await K.extractFile(f), source: 'upload', sourceRef: f })); }
        catch (e) { failed.push(`${path.basename(f)}: ${(e as Error).message}`); }
      }
      return { ok: true, added: added.length, failed };
    }
    const text = String(b.text ?? '').trim();
    if (!text) throw new HttpError(400, 'Write something to add');
    return { ok: true, id: await K.addDocument({ agentId: a.id, title: String(b.title ?? text.split('\n')[0]).slice(0, 120) || 'Note', text, source: 'note' }) };
  }));
  route('POST', '/api/custom-agents/:id/knowledge/upload', async (req) => {
    const a = agent(req, true);
    const name = path.basename(decodeURIComponent(req.query.get('name') ?? 'document')).replace(/[^\p{L}\p{N}._ -]/gu, '_') || 'document';
    const dir = path.join(config.dataDir, 'knowledge', a.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${name}`);
    let size = 0;
    const out = fs.createWriteStream(file);
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 80 * 1024 * 1024) throw new HttpError(413, 'File is larger than 80 MB');
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise<void>((r, j) => out.end((e?: Error | null) => e ? j(e) : r()));
      const text = await K.extractFile(file);
      const id = await K.addDocument({ agentId: a.id, title: name, text, source: 'upload', sourceRef: name });
      activity('user', `Taught ${a.name} from ${name}`, { detail: `${text.length.toLocaleString()} characters added to its knowledge` });
      return { ok: true, id };
    } catch (e) {
      out.destroy();
      if (e instanceof HttpError) throw e;
      throw new HttpError(e instanceof Permanent ? 415 : 400, (e as Error).message);
    } finally { fs.rm(file, { force: true }, () => {}); }
  }, { raw: true });
  route('DELETE', '/api/custom-agents/:id/knowledge/:docId', (req) => {
    const a = agent(req, true);
    if (!q.get('SELECT id FROM kb_documents WHERE id = ? AND agent_id = ?', req.params.docId, a.id)) throw new HttpError(404, 'No such document');
    K.removeDocument(req.params.docId);
    return { ok: true };
  });
  route('DELETE', '/api/custom-agents/:id/sources/:sid', (req) => { A.removeSource(agent(req, true).id, req.params.sid); return { ok: true }; });
  route('POST', '/api/custom-agents/:id/study', (req) => wrap(async () => ({ updated: await L.study(agent(req, true).id, true) })));
  route('GET', '/api/custom-agents/:id/training.jsonl', (req, res) => {
    const a = agent(req, true);
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'content-disposition': `attachment; filename="${a.name.replace(/[^\w-]+/g, '_')}-training.jsonl"` });
    res.end(L.exportTraining(a.id));
    return undefined;
  });

  route('POST', '/api/tasks/:id/feedback', (req) => wrap(async () => {
    const t = q.get('SELECT owner_id FROM tasks WHERE id = ?', req.params.id);
    if (!t) throw new HttpError(404, 'No such task');
    if (t.owner_id && t.owner_id !== uid(req) && !Org.isAdmin(uid(req))) throw new HttpError(403, 'Only whoever started this task can rate it');
    const rating = Number(req.body?.rating) > 0 ? 1 : -1;
    return L.applyFeedback(req.params.id, rating, req.body?.comment ? String(req.body.comment) : undefined, uid(req));
  }));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
    if (out.length > 500) break;
  }
  return out;
}
