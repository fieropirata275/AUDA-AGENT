#!/usr/bin/env node
/**
 * End-to-end test of the organization layer: accounts and invites, plugins
 * connected per person over OAuth (authorization code + PKCE, token refresh,
 * MCP discovery + dynamic client registration + SSE), custom agents created in
 * one click and shared, their knowledge base, and learning from outcomes and
 * feedback. Uses a scripted model and an in-process fake provider.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = 4697;
const PROV = 4721;
const BASE = `http://localhost:${PORT}`;
const PB = `http://127.0.0.1:${PROV}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-e2e-org-'));
const root = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`  ✓ ${m}`);
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// ─── fake provider: OAuth server, REST API, MCP server ───────────────────────
const codes = new Map(); // code → { challenge, user, client }
const tokens = new Map(); // access token → { user, exp }
const refreshes = new Map(); // refresh token → user
const stats = { tokenGrants: 0, refreshGrants: 0, registrations: 0, pkceChecked: 0, mcpSessions: 0 };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
const issue = (user) => {
  const access = `tok-${user}-${crypto.randomBytes(4).toString('hex')}`;
  const refresh = `ref-${user}-${crypto.randomBytes(4).toString('hex')}`;
  tokens.set(access, { user, exp: Date.now() + 2000 });
  refreshes.set(refresh, user);
  return { access_token: access, token_type: 'bearer', expires_in: 2, refresh_token: refresh, scope: 'repo' };
};
const who = (req) => { const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]; const x = t && tokens.get(t); return x && x.exp > Date.now() ? x.user : null; };
const json = (res, status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };

const provider = http.createServer(async (req, res) => {
  const url = new URL(req.url, PB);
  const p = url.pathname;
  if (p === '/oauth/authorize') {
    // The test plays the person: "login_hint" says who approves.
    const user = url.searchParams.get('login_hint') ?? 'someone';
    const code = `code-${crypto.randomBytes(6).toString('hex')}`;
    codes.set(code, { challenge: url.searchParams.get('code_challenge'), method: url.searchParams.get('code_challenge_method'), user, client: url.searchParams.get('client_id'), redirect: url.searchParams.get('redirect_uri') });
    const to = new URL(url.searchParams.get('redirect_uri'));
    to.searchParams.set('code', code); to.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { location: to.toString() }); res.end(); return;
  }
  if (p === '/oauth/token') {
    const f = new URLSearchParams(await body(req));
    if (f.get('grant_type') === 'authorization_code') {
      const c = codes.get(f.get('code'));
      codes.delete(f.get('code'));
      if (!c) return json(res, 400, { error: 'invalid_grant' });
      const expect = crypto.createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
      if (c.method !== 'S256' || expect !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      if (f.get('redirect_uri') !== c.redirect) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      if (c.client === 'gh-client' && f.get('client_secret') !== 'gh-secret') return json(res, 401, { error: 'invalid_client' });
      stats.pkceChecked++; stats.tokenGrants++;
      return json(res, 200, issue(c.user));
    }
    if (f.get('grant_type') === 'refresh_token') {
      const user = refreshes.get(f.get('refresh_token'));
      refreshes.delete(f.get('refresh_token')); // rotation: old refresh tokens die
      if (!user) return json(res, 400, { error: 'invalid_grant' });
      stats.refreshGrants++;
      return json(res, 200, issue(user));
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
  if (p === '/oauth/register') {
    const b = JSON.parse(await body(req));
    stats.registrations++;
    return json(res, 201, { client_id: `dyn-${stats.registrations}`, redirect_uris: b.redirect_uris, token_endpoint_auth_method: 'none' });
  }
  if (p === '/.well-known/oauth-authorization-server') return json(res, 200, { issuer: PB, authorization_endpoint: `${PB}/oauth/authorize`, token_endpoint: `${PB}/oauth/token`, registration_endpoint: `${PB}/oauth/register`, code_challenge_methods_supported: ['S256'] });
  if (p.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, { resource: `${PB}/mcp`, authorization_servers: [PB], scopes_supported: ['weather'] });
  // REST API
  if (p === '/api/search/issues') {
    const user = who(req);
    if (!user) return json(res, 401, { message: 'Bad credentials' });
    return json(res, 200, { total_count: 1, items: [{ number: 7, title: 'Crash on save', user: { login: user, name: user === 'bob' ? 'Bob Example' : user } }] });
  }
  if (p === '/api/repos/acme/app/issues/7/comments' && req.method === 'POST') {
    if (!who(req)) return json(res, 401, { message: 'Bad credentials' });
    const b = JSON.parse(await body(req));
    return json(res, 201, { id: 'comment-created', body: b.body });
  }
  // MCP (Streamable HTTP)
  if (p === '/mcp') {
    if (!who(req)) { res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${PB}/.well-known/oauth-protected-resource/mcp"` }); res.end(); return; }
    const m = JSON.parse(await body(req));
    if (m.method === 'initialize') { stats.mcpSessions++; return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'weather', version: '1' } } }, { 'mcp-session-id': `s${stats.mcpSessions}` }); }
    if (!req.headers['mcp-session-id']) return json(res, 400, { error: 'missing session' });
    if (m.id === undefined) { res.writeHead(202); res.end(); return; }
    if (m.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'get_forecast', description: 'Weather forecast for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, annotations: { readOnlyHint: true } }] } });
    if (m.method === 'tools/call') {
      // Answer over SSE with a progress notification first, like real servers do.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
      await sleep(50);
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `Sunny, 24°C in ${m.params.arguments.city}` }] } })}\n\n`);
      return;
    }
    return json(res, 200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
  }
  res.writeHead(404); res.end();
});

// ─── AUDA ────────────────────────────────────────────────────────────────────
let core, logs = '';
function boot() {
  core = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: root, env: { ...process.env, AUDA_DATA: data, AUDA_PORT: String(PORT), AUDA_PUBLIC_URL: BASE, AUDA_MOCK_MODEL: path.join(root, 'scripts/mock-model.mjs') }, stdio: ['ignore', 'pipe', 'pipe'] });
  core.stdout.on('data', (d) => { logs += d; }); core.stderr.on('data', (d) => { logs += d; });
}
const call = async (method, p, b, token, raw) => {
  const r = await fetch(BASE + p, { method, headers: { ...(b && !raw ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw ?? (b ? JSON.stringify(b) : undefined) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { text }; }
  return { status: r.status, j };
};
const api = async (method, p, b, token) => { const r = await call(method, p, b, token); if (r.status >= 300) throw new Error(`${method} ${p}: ${r.status} ${r.j.error}`); return r.j; };
async function up() { for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* booting */ } await sleep(500); } throw new Error('core did not start'); }
async function until(label, fn, timeout = 60_000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await sleep(400); } throw new Error(`timed out: ${label}`); }
const done = (id, token, states = ['COMPLETED']) => until(`task ${id} → ${states}`, async () => { const t = await api('GET', `/api/tasks/${id}`, null, token); if (['FAILED', 'CANCELLED'].includes(t.state) && !states.includes(t.state)) throw new Error(`task ${t.title} ${t.state}: ${t.diagnosis ?? t.error}`); return states.includes(t.state) ? t : null; });

/** Play the person in the browser: follow the provider's consent redirect back into AUDA. */
async function consent(authUrl, user) {
  const u = new URL(authUrl); u.searchParams.set('login_hint', user);
  const r1 = await fetch(u, { redirect: 'manual' });
  const back = r1.headers.get('location');
  must(back?.startsWith(`${BASE}/api/oauth/callback`), `provider did not redirect to AUDA: ${back}`);
  const r2 = await fetch(back);
  const html = await r2.text();
  must(r2.ok && html.includes('connected'), `callback failed: ${html.replace(/<[^>]+>/g, ' ').slice(0, 300)}`);
}

let failed = false;
try {
  await new Promise((r) => provider.listen(PROV, '127.0.0.1', r));
  boot(); await up();
  step('core booted (scripted model, fake OAuth/API/MCP provider)');

  // 1. Accounts.
  const setup = await api('POST', '/api/org/setup', { orgName: 'Acme', name: 'Ada Owner', email: 'ada@acme.test', password: 'correct horse battery' });
  const ada = setup.token;
  must((await call('GET', '/api/bootstrap')).status === 401, 'with the org on, anonymous requests must be refused');
  must((await call('POST', '/api/auth/login', { email: 'ada@acme.test', password: 'wrong password!' })).status === 401, 'bad password must fail');
  must((await api('POST', '/api/auth/login', { email: 'ada@acme.test', password: 'correct horse battery' })).token, 'login should work');
  const inv = await api('POST', '/api/org/invites', { role: 'member' }, ada);
  const info = await api('GET', `/api/join/${inv.code}`);
  must(info.org === 'Acme', 'invite info should name the org');
  const bob = (await api('POST', '/api/join', { code: inv.code, name: 'Bob', email: 'bob@acme.test', password: 'hunter2hunter2' })).token;
  must((await call('POST', '/api/join', { code: inv.code, name: 'Eve', email: 'eve@acme.test', password: 'hunter2hunter2' })).status === 400, 'an invite works once');
  const meB = await api('GET', '/api/auth/me', null, bob);
  must(meB.user.name === 'Bob' && meB.user.role === 'member', 'Bob should be a member');
  must((await call('POST', '/api/org/invites', {}, bob)).status === 400, 'members cannot invite');
  step('organization: owner set up Acme, invited Bob (one-time code); anonymous and bad logins refused');

  // 2. Plugins: GitHub preset pointed at the fake provider; each person connects their own account.
  const gh = await api('POST', '/api/plugins', { preset: 'github', baseUrl: `${PB}/api`, auth: { authorizeUrl: `${PB}/oauth/authorize`, tokenUrl: `${PB}/oauth/token` }, clientId: 'gh-client', clientSecret: 'gh-secret' }, ada);
  must(gh.visibility === 'org' && gh.tools.length === 4, 'admin-added preset should be shared with 4 tools');
  const listB = await api('GET', '/api/plugins', null, bob);
  must(listB.plugins.some((p) => p.id === gh.id && !p.connection && !p.canManage), 'Bob sees the shared plugin, unconnected, and cannot manage it');
  must(listB.presets.length >= 7, 'presets listed');
  must((await call('PATCH', `/api/plugins/${gh.id}`, { name: 'Mine now' }, bob)).status === 403, 'Bob cannot edit the org plugin');
  const start = await api('POST', `/api/plugins/${gh.id}/connect`, { returnTo: '/plugins' }, bob);
  must(start.url.includes('code_challenge=') && start.url.includes('code_challenge_method=S256'), 'authorization URL must use PKCE S256');
  await consent(start.url, 'bob');
  const ghB = (await api('GET', '/api/plugins', null, bob)).plugins.find((p) => p.id === gh.id);
  const ghA = (await api('GET', '/api/plugins', null, ada)).plugins.find((p) => p.id === gh.id);
  must(ghB.connection?.state === 'connected' && !ghA.connection, 'only Bob is connected');
  must(stats.pkceChecked === 1, 'provider verified PKCE');
  const test = await api('POST', `/api/plugins/${gh.id}/test`, { tool: 'search_issues', args: { q: 'bug' } }, bob);
  must(test.preview.includes('Bob Example'), 'test call uses Bob’s token');
  step('plugins: GitHub preset shared by the admin; Bob connected his own account (OAuth code + PKCE + client secret); Ada is not connected');

  // MCP server with OAuth discovery + dynamic client registration + SSE.
  const mcp = await api('POST', '/api/plugins', { kind: 'mcp', name: 'Weather', mcpUrl: `${PB}/mcp`, auth: { type: 'oauth2', discovered: true } }, ada);
  const mstart = await api('POST', `/api/plugins/${mcp.id}/connect`, {}, ada);
  must(stats.registrations === 1 && mstart.url.includes('client_id=dyn-1') && mstart.url.includes('resource='), 'MCP connect should discover auth, register a client and send the resource');
  await consent(mstart.url, 'ada');
  const mv = (await api('GET', '/api/plugins', null, ada)).plugins.find((p) => p.id === mcp.id);
  must(mv.connection?.state === 'connected' && mv.tools.some((t) => t.name === 'get_forecast' && t.readOnly), `MCP tools should be listed after connecting: ${JSON.stringify(mv.tools)}`);
  step('MCP: discovered the authorization server, registered AUDA dynamically, connected Ada, listed tools');

  // 3. One-click custom agent from a description, with a knowledge base.
  const ag = await api('POST', '/api/custom-agents', { describe: 'An expert on bolt torque from our maintenance manual', visibility: 'org',
    notes: 'Maintenance manual, section 4 (fasteners). M8 flange bolts are tightened to 42 Nm in a star pattern. M10 bolts take 70 Nm. Always use a calibrated torque wrench.' }, ada);
  must(ag.name === 'Torque Expert' && ag.knowledge.documents === 1, `agent should be drafted and seeded: ${ag.name} ${JSON.stringify(ag.knowledge)}`);
  const up1 = await call('POST', `/api/custom-agents/${ag.id}/knowledge/upload?name=${encodeURIComponent('paint-guide.md')}`, true, ada, '# Paint guide\n\nPrimer must cure 24 hours before the top coat. Use RAL 7035 for cabinets.\n');
  must(up1.status === 200, `upload should be indexed: ${up1.j.error}`);
  await api('POST', `/api/custom-agents/${ag.id}/knowledge`, { type: 'note', title: 'Shop hours', text: 'The workshop is open 7:00–15:00 on weekdays.' }, ada);
  const hits = await api('GET', `/api/custom-agents/${ag.id}/search?q=${encodeURIComponent('torque for M8 bolts')}`, null, ada);
  must(hits[0]?.text.includes('42 Nm'), `retrieval should rank the torque passage first: ${JSON.stringify(hits.map((h) => h.title))}`);
  step(`one-click agent: “${ag.name}” drafted from a sentence, taught from a note, an upload and a pasted note; search ranks the right passage first`);

  // 4. Sharing: Bob can use it (as himself) but not change it; he can fork it.
  const bootB = await api('GET', '/api/bootstrap', null, bob);
  must(bootB.customAgents.some((a) => a.id === ag.id && !a.canEdit), 'Bob sees the shared agent, read-only');
  must((await call('PATCH', `/api/custom-agents/${ag.id}`, { name: 'Hijacked' }, bob)).status === 403, 'Bob cannot edit Ada’s agent');
  const fork = await api('POST', `/api/custom-agents/${ag.id}/duplicate`, {}, bob);
  must(fork.mine && fork.visibility === 'private' && fork.knowledge.documents === 3, `fork should be Bob’s own private copy with the knowledge: ${JSON.stringify(fork.knowledge)}`);
  step('sharing: Bob sees “Torque Expert” read-only, edits are refused, and he forked a private copy with its knowledge');

  // 5. Bob runs the shared agent; it answers from knowledge and learns.
  const { id: t1 } = await api('POST', `/api/custom-agents/${ag.id}/run`, { goal: 'What torque for the M8 flange bolts?' }, bob);
  const r1 = await done(t1, bob);
  must(r1.result.includes('42 Nm') && r1.ownerId !== 'user_owner' && r1.agentId === ag.id, `answer should come from knowledge, owned by Bob: ${r1.result}`);
  const learned = await until('learning after the task', async () => { const a = await api('GET', `/api/custom-agents/${ag.id}`, null, ada); return a.learning.updates > 0 && a.knowledge.lessons >= 2 ? a : null; }, 20_000);
  const lessonTitles = learned.documents.filter((d) => d.kind !== 'doc').map((d) => d.title);
  must(lessonTitles.includes('Torque table lives in the manual') && lessonTitles.includes('Quote units with torque values'), `expected lessons from the learn tool and reflection: ${lessonTitles}`);
  must(learned.learning.history.at(-1).positives >= 1, 'the used passage should be labelled positive');
  step(`learning: answered “${r1.result.slice(0, 60)}…”; labelled ${learned.learning.history.at(-1).labelled} retrievals, re-ranker updated, ${learned.knowledge.lessons} lessons + ${learned.knowledge.skills} skill learned`);

  const fb = await api('POST', `/api/tasks/${t1}/feedback`, { rating: 1, comment: 'Perfect, quoting the section number helps.' }, bob);
  must(fb.learned, 'feedback should feed learning');
  must((await call('POST', `/api/tasks/${t1}/feedback`, { rating: 1 }, (await api('POST', '/api/join', { code: (await api('POST', '/api/org/invites', {}, ada)).code, name: 'Cy', email: 'cy@acme.test', password: 'cycycycycy' })).token)).status === 403, 'others cannot rate Bob’s task');
  const after = await api('GET', `/api/custom-agents/${ag.id}`, null, ada);
  must(after.documents.some((d) => d.title.startsWith('What Bob liked')), 'positive comment becomes a lesson');
  must(after.stats.rating === 100, `rating should show 100%: ${after.stats.rating}`);
  must((await api('GET', '/api/bootstrap', null, ada)).tasks.some((t) => t.id === t1), 'the admin supervises Bob’s task');
  must(!(await api('GET', '/api/bootstrap', null, bob)).tasks.some((t) => t.ownerId === 'user_owner'), 'Bob does not see Ada’s tasks');
  step(`feedback: Bob’s 👍 and comment became a lesson; rating 100%; re-ranker trained on ${after.learning.updates} examples (weights ${after.learning.weights.map((x) => x.toFixed(2)).join('/')})`);

  // 6. Plugins inside agents, per person: Bob’s agent uses Bob’s GitHub; writes ask first; tokens refresh.
  await sleep(2500); // Bob's access token (2 s lifetime) has expired: the call must refresh it.
  const { id: t2 } = await api('POST', `/api/custom-agents/${ag.id}/run`, { goal: 'Check my issues and comment on #7' , title: 'Check my issues' }, bob);
  const apr = await until('write approval', async () => (await api('GET', '/api/bootstrap', null, bob)).approvals.find((a) => a.taskId === t2 && a.state === 'pending'), 30_000);
  must(/GitHub → comment/.test(apr.title), `approval should name the app and tool: ${apr.title}`);
  must(stats.refreshGrants >= 1, 'an expired token should have been refreshed');
  await api('POST', `/api/approvals/${apr.id}/decide`, { decision: 'approved' }, bob);
  const r2 = await done(t2, bob);
  must(r2.result.includes('Saw Bob’s issues') && r2.result.includes('posted'), `agent should use Bob’s account: ${r2.result}`);
  const { id: t3 } = await api('POST', `/api/custom-agents/${ag.id}/run`, { goal: 'Check my issues', title: 'Check my issues' }, ada);
  const r3 = await done(t3, ada);
  must(r3.result.includes('NO PLUGIN TOOL'), `Ada has no GitHub connection, so her run must not get Bob’s: ${r3.result}`);
  must((await call('GET', `/api/tasks/${t3}`, null, bob)).status === 404 && (await call('POST', `/api/tasks/${t3}/cancel`, {}, bob)).status === 404, 'Bob cannot read or control Ada’s task');
  step(`plugins in agents: Bob’s run read his issues, refreshed his expired token (${stats.refreshGrants} refresh), asked before commenting; Ada’s run got no access to Bob’s account`);

  const { id: t4 } = await api('POST', '/api/tasks', { title: 'Forecast for Lisbon' }, ada);
  const r4 = await done(t4, ada);
  must(r4.result.includes('Sunny, 24°C in Lisbon'), `MCP call over SSE: ${r4.result}`);
  step('MCP in agents: tools/call answered over SSE (after a progress event) → “Sunny, 24°C in Lisbon”');

  // 7. Restart: connections, agents, knowledge and the learned ranker persist.
  core.kill('SIGTERM'); await sleep(1500);
  boot(); await up();
  const persisted = await api('GET', `/api/custom-agents/${ag.id}`, null, ada);
  must(persisted.learning.updates === after.learning.updates + 0 || persisted.learning.updates >= after.learning.updates, 'ranker persisted');
  const hits2 = await api('GET', `/api/custom-agents/${ag.id}/search?q=${encodeURIComponent('M8 torque')}`, null, bob);
  must(hits2.some((h) => h.text.includes('42 Nm')), 'knowledge persisted');
  must((await api('GET', '/api/plugins', null, bob)).plugins.find((p) => p.id === gh.id).connection.state === 'connected', 'connection persisted');
  await api('POST', `/api/plugins/${gh.id}/disconnect`, {}, bob);
  must(!(await api('GET', '/api/plugins', null, bob)).plugins.find((p) => p.id === gh.id).connection, 'disconnect removes the connection');
  const jsonl = await fetch(`${BASE}/api/custom-agents/${ag.id}/training.jsonl`, { headers: { authorization: `Bearer ${ada}` } }).then((r) => r.text());
  must(jsonl.split('\n').filter(Boolean).every((l) => JSON.parse(l).type), 'training export is valid JSONL');
  step(`restart: sessions, connections, agents, knowledge and the learned ranker survived; Bob disconnected; training export has ${jsonl.trim().split('\n').length} rows`);

  console.log('\n  organization, plugins, custom agents & learning: PASS\n');
} catch (e) {
  failed = true;
  console.error(`\n  ✕ ${e.message}\n`);
  console.error(logs.split('\n').slice(-40).join('\n'));
} finally {
  core?.kill('SIGTERM');
  provider.close();
  await sleep(500);
  fs.rmSync(data, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
