/**
 * Plugins: external apps the agents can use as tools.
 *
 * A plugin is registered once for the organization (an OpenAPI-style HTTP API
 * or a remote MCP server). Each member connects their *own* account to it —
 * OAuth 2.1 authorization code + PKCE, an API key, or nothing — and agents
 * working for that member call its tools with that member's credentials only.
 *
 * Reliability rules:
 *  - tokens live in the secret broker, never in plugin rows or model context;
 *  - access tokens refresh shortly before expiry, single-flight per connection,
 *    and once more on a 401; a refused refresh marks the connection "expired"
 *    so the member is asked to reconnect instead of the agent looping;
 *  - every call has a timeout, errors are classified (rate limits and 5xx are
 *    retried by the engine, 4xx are not), and a per-plugin circuit breaker
 *    stops hammering a service that is down;
 *  - all calls go through the tool broker, so rules, approvals (writes ask by
 *    default), idempotency and the audit log apply exactly as for built-ins.
 */
import crypto from 'node:crypto';
import { config } from '../core/config.ts';
import { getSetting, insert, json, now, q, uid, update } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { activity } from '../core/activity.ts';
import { log } from '../core/log.ts';
import { currentUserId } from '../core/context.ts';
import { putSecret, resolveSecret, deleteSecret } from '../secrets/broker.ts';
import { Permanent, Transient } from '../tools/errors.ts';
import { PRESETS, type PluginConfig, type PluginTool } from './presets.ts';
import { registerTool } from '../tools/broker.ts';

export const MAX_TOOLS = 40;
const CALL_TIMEOUT = Number(process.env.AUDA_PLUGIN_TIMEOUT_MS ?? 30_000);
const MAX_BODY = 60_000;

export interface PluginRow {
  id: string; name: string; kind: 'openapi' | 'mcp'; preset: string | null; description: string | null; icon: string | null;
  config: PluginConfig; clientSecretRef: string | null; createdBy: string | null; visibility: 'org' | 'private'; createdAt: number;
}

export const publicBase = () => String(getSetting('server.publicUrl', '') || config.publicUrl).replace(/\/$/, '');
export const redirectUri = () => `${publicBase()}/api/oauth/callback`;
const b64url = (b: Buffer) => b.toString('base64url');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'plugin';

function row(r: any): PluginRow | undefined {
  if (!r) return undefined;
  return { id: r.id, name: r.name, kind: r.kind, preset: r.preset, description: r.description, icon: r.icon, config: json<PluginConfig>(r.config_json, { auth: { type: 'none' }, tools: [] }),
    clientSecretRef: r.client_secret_ref, createdBy: r.created_by, visibility: r.visibility ?? 'org', createdAt: r.created_at };
}
export const getPlugin = (id: string) => row(q.get('SELECT * FROM plugins WHERE id = ?', id));

/** Plugins a member may see and connect: everything shared with the org, plus their own private ones. */
export function visiblePlugins(userId = currentUserId()): PluginRow[] {
  return q.all("SELECT * FROM plugins WHERE visibility = 'org' OR created_by = ? ORDER BY created_at", userId).map((r) => row(r)!);
}
export function canManage(p: PluginRow, userId: string) {
  return p.createdBy === userId || q.get("SELECT role FROM users WHERE id = ?", userId)?.role === 'admin' || userId === 'user_owner';
}
const connection = (pluginId: string, userId: string) => q.get('SELECT * FROM plugin_connections WHERE plugin_id = ? AND user_id = ?', pluginId, userId);

export function pluginView(p: PluginRow, userId = currentUserId()) {
  const c = connection(p.id, userId);
  const a = p.config.auth;
  return {
    id: p.id, name: p.name, kind: p.kind, preset: p.preset, description: p.description, icon: p.icon ?? 'plug', visibility: p.visibility,
    createdBy: p.createdBy, mine: p.createdBy === userId, canManage: canManage(p, userId),
    auth: a.type, oauthReady: a.type !== 'oauth2' || !!(a.clientId || a.discovered), discovered: !!a.discovered,
    baseUrl: p.config.baseUrl, mcpUrl: p.config.mcpUrl, redirectUri: redirectUri(),
    setup: PRESETS.find((x) => x.id === p.preset)?.setup,
    tools: p.config.tools.map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly })),
    connection: c ? { state: c.state, account: c.account, error: c.error, expiresAt: c.expires_at, updatedAt: c.updated_at } : null,
    connectedUsers: q.get("SELECT COUNT(*) n FROM plugin_connections WHERE plugin_id = ? AND state = 'connected'", p.id)!.n,
  };
}

// ─── registration ────────────────────────────────────────────────────────────

export interface NewPlugin {
  preset?: string; name?: string; kind?: 'openapi' | 'mcp'; description?: string; icon?: string;
  baseUrl?: string; mcpUrl?: string; openapiUrl?: string; spec?: any;
  auth?: Partial<PluginConfig['auth']>; clientId?: string; clientSecret?: string; tools?: PluginTool[]; visibility?: 'org' | 'private';
}

export async function createPlugin(n: NewPlugin, userId = currentUserId()): Promise<PluginRow> {
  let cfg: PluginConfig; let name = n.name; let kind = n.kind ?? 'openapi'; let description = n.description; let icon = n.icon;
  const preset = n.preset ? PRESETS.find((p) => p.id === n.preset) : undefined;
  if (n.preset && !preset) throw new Permanent(`Unknown preset ${n.preset}`);
  if (preset) {
    cfg = structuredClone(preset.config); name ??= preset.name; kind = preset.kind; description ??= preset.description; icon ??= preset.icon;
    // Self-hosted variants (GitHub Enterprise, a proxy): override the endpoints, keep the tools.
    if (n.baseUrl) cfg.baseUrl = n.baseUrl;
    if (n.auth) cfg.auth = { ...cfg.auth, ...n.auth } as PluginConfig['auth'];
  } else if (kind === 'mcp') {
    if (!n.mcpUrl) throw new Permanent('An MCP plugin needs the server URL');
    cfg = { mcpUrl: n.mcpUrl, auth: { type: 'none', ...n.auth }, tools: [] };
  } else if (n.openapiUrl || n.spec) {
    cfg = await importOpenApi(n.spec ?? n.openapiUrl);
    if (n.baseUrl) cfg.baseUrl = n.baseUrl;
    if (n.auth) cfg.auth = { ...cfg.auth, ...n.auth } as PluginConfig['auth'];
    name ??= cfg.docs;
  } else {
    if (!n.baseUrl) throw new Permanent('Give the API base URL, an OpenAPI document, or pick a preset');
    cfg = { baseUrl: n.baseUrl, auth: { type: 'none', ...n.auth } as PluginConfig['auth'], tools: (n.tools ?? []).slice(0, MAX_TOOLS) };
  }
  if (n.clientId) cfg.auth.clientId = n.clientId.trim();
  const id = uid('plg');
  insert('plugins', {
    id, name: (name ?? 'Plugin').slice(0, 60), kind, preset: preset?.id ?? null, description: description ?? null, icon: icon ?? (kind === 'mcp' ? 'plug' : 'globe'),
    config_json: JSON.stringify(cfg), client_secret_ref: n.clientSecret ? putSecret(`plugin:${id}:client_secret`, n.clientSecret.trim()) : null,
    created_by: userId, visibility: n.visibility ?? 'org', created_at: now(),
  });
  // An MCP server without auth can list its tools right away.
  if (kind === 'mcp' && cfg.auth.type === 'none') await refreshMcpTools(id, userId).catch((e) => log.warn('mcp tools/list failed', String(e)));
  changed('plugin', id);
  activity('user', `Added the ${name} plugin`, { detail: kind === 'mcp' ? `MCP server ${cfg.mcpUrl}` : `${cfg.tools.length} tools · ${cfg.baseUrl}` });
  return getPlugin(id)!;
}

export function updatePlugin(id: string, patch: { name?: string; description?: string; visibility?: 'org' | 'private'; clientId?: string; clientSecret?: string; baseUrl?: string; disabledTools?: string[] }) {
  const p = getPlugin(id)!;
  const cfg = p.config;
  if (patch.clientId !== undefined) cfg.auth.clientId = patch.clientId.trim() || undefined;
  if (patch.baseUrl) cfg.baseUrl = patch.baseUrl;
  const set: Record<string, any> = { config_json: JSON.stringify(cfg) };
  if (patch.name) set.name = patch.name.slice(0, 60);
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.visibility) set.visibility = patch.visibility;
  if (patch.clientSecret) { if (p.clientSecretRef) deleteSecret(p.clientSecretRef); set.client_secret_ref = putSecret(`plugin:${id}:client_secret`, patch.clientSecret.trim()); }
  update('plugins', id, set);
  changed('plugin', id);
}

export function deletePlugin(id: string) {
  const p = getPlugin(id);
  if (!p) return;
  for (const c of q.all('SELECT * FROM plugin_connections WHERE plugin_id = ?', id)) dropTokens(c);
  q.run('DELETE FROM plugin_connections WHERE plugin_id = ?', id);
  q.run('DELETE FROM oauth_states WHERE plugin_id = ?', id);
  if (p.clientSecretRef) deleteSecret(p.clientSecretRef);
  q.run('DELETE FROM plugins WHERE id = ?', id);
  mcpSessions.forEach((_, k) => { if (k.startsWith(id)) mcpSessions.delete(k); });
  changed('plugin', id, true);
  activity('user', `Removed the ${p.name} plugin`);
}

// ─── connections ─────────────────────────────────────────────────────────────

function dropTokens(c: any) { if (c?.token_ref) deleteSecret(c.token_ref); if (c?.refresh_ref) deleteSecret(c.refresh_ref); }

function saveConnection(pluginId: string, userId: string, patch: { token?: string; refresh?: string | null; expiresIn?: number | null; account?: string | null; scopes?: string | null; state: string; error?: string | null }) {
  const c = connection(pluginId, userId);
  const set: Record<string, any> = { state: patch.state, error: patch.error ?? null, updated_at: now() };
  if (patch.token !== undefined) { if (c?.token_ref) deleteSecret(c.token_ref); set.token_ref = patch.token ? putSecret(`plugin:${pluginId}:${userId}:token`, patch.token) : null; }
  // string → replace, null → drop, undefined → keep (providers that don't rotate refresh tokens omit them).
  if (patch.refresh !== undefined) {
    if (c?.refresh_ref) deleteSecret(c.refresh_ref);
    set.refresh_ref = patch.refresh ? putSecret(`plugin:${pluginId}:${userId}:refresh`, patch.refresh) : null;
  }
  if (patch.expiresIn !== undefined) set.expires_at = patch.expiresIn ? now() + patch.expiresIn * 1000 : null;
  if (patch.account !== undefined) set.account = patch.account;
  if (patch.scopes !== undefined) set.scopes = patch.scopes;
  if (c) q.run(`UPDATE plugin_connections SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(set), c.id);
  else insert('plugin_connections', { id: uid('pcn'), plugin_id: pluginId, user_id: userId, created_at: now(), ...set });
  changed('plugin', pluginId);
}

/** Begin connecting the current member's account. Returns a URL to open (OAuth) or asks for a key. */
export async function startConnect(pluginId: string, userId = currentUserId(), returnTo?: string): Promise<{ url?: string; needsKey?: boolean; connected?: boolean }> {
  const p = getPlugin(pluginId);
  if (!p) throw new Permanent('No such plugin');
  let a = p.config.auth;
  if (a.type === 'apiKey' || a.type === 'bearer') return { needsKey: true };
  if (a.type === 'none') {
    saveConnection(pluginId, userId, { state: 'connected', token: '' });
    if (p.kind === 'mcp') await refreshMcpTools(pluginId, userId);
    return { connected: true };
  }
  if (a.discovered && (!a.authorizeUrl || !a.clientId)) a = await discoverAuth(p);
  if (!a.authorizeUrl || !a.tokenUrl) throw new Permanent(`${p.name} has no OAuth endpoints configured`);
  if (!a.clientId) throw new Permanent(`${p.name} needs an OAuth client id first. An admin can add it in Plugins → ${p.name}.`);
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(24));
  q.run('DELETE FROM oauth_states WHERE created_at < ?', now() - 20 * 60_000);
  insert('oauth_states', { state, plugin_id: pluginId, user_id: userId, verifier, redirect_uri: redirectUri(), return_to: returnTo ?? null, created_at: now() });
  const url = new URL(a.authorizeUrl);
  const params: Record<string, string> = {
    response_type: 'code', client_id: a.clientId, redirect_uri: redirectUri(), state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    ...(a.scopes?.length ? { scope: a.scopes.join(' ') } : {}), ...(a.resource ? { resource: a.resource } : {}), ...(a.extraAuthParams ?? {}),
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  saveConnection(pluginId, userId, { state: 'connecting' });
  return { url: url.toString() };
}

export function saveKey(pluginId: string, key: string, userId = currentUserId()) {
  if (!key.trim()) throw new Permanent('Enter the key');
  saveConnection(pluginId, userId, { state: 'connected', token: key.trim(), refresh: null, expiresIn: null, account: `key ${key.trim().slice(0, 4)}…` });
  activity('user', `Connected ${getPlugin(pluginId)?.name} with a key`);
}

export function disconnect(pluginId: string, userId = currentUserId()) {
  const c = connection(pluginId, userId);
  if (!c) return;
  dropTokens(c);
  q.run('DELETE FROM plugin_connections WHERE id = ?', c.id);
  mcpSessions.delete(`${pluginId}:${userId}`);
  changed('plugin', pluginId);
}

async function tokenRequest(p: PluginRow, body: Record<string, string>) {
  const a = p.config.auth;
  const secret = resolveSecret(p.clientSecretRef);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const form = new URLSearchParams({ ...body, client_id: a.clientId ?? '' });
  if (secret && a.tokenAuth === 'basic') headers.authorization = `Basic ${Buffer.from(`${a.clientId}:${secret}`).toString('base64')}`;
  else if (secret) form.set('client_secret', secret);
  if (a.resource) form.set('resource', a.resource);
  const res = await fetch(a.tokenUrl!, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(CALL_TIMEOUT) });
  const text = await res.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = Object.fromEntries(new URLSearchParams(text)); }
  const token = j.access_token ?? j.authed_user?.access_token;
  if (!res.ok || !token) {
    const err = j.error_description ?? j.error ?? `HTTP ${res.status}`;
    throw Object.assign(new Error(`${p.name} refused the token request: ${err}`), { status: res.ok ? 400 : res.status, oauthError: j.error });
  }
  return {
    token: String(token), refresh: j.refresh_token ?? j.authed_user?.refresh_token ?? null,
    expiresIn: Number(j.expires_in ?? j.authed_user?.expires_in ?? 0) || null, scopes: j.scope ?? j.authed_user?.scope ?? null,
    account: j.email ?? j.workspace_name ?? j.team?.name ?? j.user?.login ?? j.owner?.user?.name ?? null,
  };
}

/** Finish the OAuth flow from the provider's redirect. */
export async function finishOAuth(state: string, code: string | null, error: string | null): Promise<{ plugin: string; returnTo?: string; ok: boolean; message: string }> {
  const s = q.get('SELECT * FROM oauth_states WHERE state = ?', state);
  if (!s) return { plugin: 'plugin', ok: false, message: 'This sign-in link expired or was already used. Start connecting again from AUDA.' };
  q.run('DELETE FROM oauth_states WHERE state = ?', state);
  const p = getPlugin(s.plugin_id);
  if (!p) return { plugin: 'plugin', ok: false, message: 'That plugin was removed.' };
  if (error || !code) {
    saveConnection(p.id, s.user_id, { state: 'error', error: error ?? 'No authorization code returned' });
    return { plugin: p.name, returnTo: s.return_to, ok: false, message: error === 'access_denied' ? 'You declined access. Nothing was connected.' : `${p.name} returned an error: ${error ?? 'no code'}` };
  }
  if (now() - s.created_at > 15 * 60_000) return { plugin: p.name, ok: false, message: 'This sign-in took too long. Start again.' };
  try {
    const t = await tokenRequest(p, { grant_type: 'authorization_code', code, redirect_uri: s.redirect_uri, code_verifier: s.verifier });
    saveConnection(p.id, s.user_id, { state: 'connected', token: t.token, refresh: t.refresh, expiresIn: t.expiresIn, account: t.account, scopes: t.scopes });
    if (p.kind === 'mcp') await refreshMcpTools(p.id, s.user_id).catch((e) => log.warn('mcp tools/list failed', String(e)));
    const who = q.get('SELECT name FROM users WHERE id = ?', s.user_id)?.name;
    activity('user', `${who ?? 'You'} connected ${p.name}`, { detail: t.account ? `Account: ${t.account}` : undefined });
    return { plugin: p.name, returnTo: s.return_to, ok: true, message: `${p.name} is connected. AUDA agents working for you can use it now.` };
  } catch (e) {
    saveConnection(p.id, s.user_id, { state: 'error', error: (e as Error).message });
    return { plugin: p.name, returnTo: s.return_to, ok: false, message: (e as Error).message };
  }
}

const refreshing = new Map<string, Promise<string>>();

/** A valid credential for this member, refreshing it if needed. */
export async function credential(p: PluginRow, userId: string, force = false): Promise<string | undefined> {
  if (p.config.auth.type === 'none') return undefined;
  const c = connection(p.id, userId);
  const who = userId === currentUserId() ? 'you' : 'the person this agent works for';
  if (!c || !['connected', 'refreshing'].includes(c.state)) {
    throw new Permanent(`${p.name} is not connected for ${who}${c?.state === 'expired' ? ' (the connection expired)' : ''}. Connect it in Plugins, then retry.`);
  }
  const fresh = !c.expires_at || c.expires_at - now() > 90_000;
  if (fresh && !force) return resolveSecret(c.token_ref) ?? '';
  if (!c.refresh_ref) {
    if (c.expires_at && c.expires_at < now()) { saveConnection(p.id, userId, { state: 'expired', error: 'Access expired and the service gave no refresh token' }); throw new Permanent(`${p.name} access expired. Reconnect it in Plugins.`); }
    return resolveSecret(c.token_ref) ?? '';
  }
  const key = `${p.id}:${userId}`;
  if (!refreshing.has(key)) {
    refreshing.set(key, (async () => {
      try {
        const t = await tokenRequest(p, { grant_type: 'refresh_token', refresh_token: resolveSecret(c.refresh_ref)! });
        saveConnection(p.id, userId, { state: 'connected', token: t.token, refresh: t.refresh ?? undefined, expiresIn: t.expiresIn });
        return t.token;
      } catch (e: any) {
        if (e.oauthError === 'invalid_grant' || e.status === 400 || e.status === 401) {
          saveConnection(p.id, userId, { state: 'expired', error: e.message });
          throw new Permanent(`${p.name} access was revoked or expired. Reconnect it in Plugins.`);
        }
        throw new Transient(`Couldn't refresh ${p.name} access: ${e.message}`);
      } finally { refreshing.delete(key); }
    })());
  }
  return refreshing.get(key)!;
}

function authHeaders(p: PluginRow, token: string | undefined): Record<string, string> {
  const a = p.config.auth;
  if (!token) return {};
  if (a.type === 'apiKey') return { [a.apiKeyHeader ?? 'x-api-key']: `${a.apiKeyPrefix ?? ''}${token}` };
  return { authorization: `Bearer ${token}` };
}

// ─── circuit breaker ─────────────────────────────────────────────────────────

const breakers = new Map<string, { failures: number; openUntil: number }>();
async function guarded<T>(p: PluginRow, fn: () => Promise<T>): Promise<T> {
  const b = breakers.get(p.id) ?? { failures: 0, openUntil: 0 };
  if (b.openUntil > Date.now()) throw new Transient(`${p.name} is cooling down after repeated failures (until ${new Date(b.openUntil).toLocaleTimeString()})`);
  try {
    const r = await fn();
    breakers.delete(p.id);
    return r;
  } catch (e) {
    if (!(e instanceof Permanent)) {
      b.failures++;
      if (b.failures >= 5) { b.openUntil = Date.now() + 3 * 60_000; b.failures = 0; activity('problem', `${p.name} keeps failing — pausing calls for 3 minutes`, { detail: String((e as Error).message) }); }
      breakers.set(p.id, b);
    }
    throw e;
  }
}

function httpError(p: PluginRow, status: number, body: string) {
  const snippet = body.replace(/\s+/g, ' ').slice(0, 400);
  if (status === 429 || status >= 500 || status === 408) return new Transient(`${p.name} answered HTTP ${status}: ${snippet}`);
  return new Permanent(`${p.name} answered HTTP ${status}: ${snippet}`);
}

// ─── tool calls ──────────────────────────────────────────────────────────────

export function findTool(p: PluginRow, name: string) { return p.config.tools.find((t) => t.name === name); }

/** Call one plugin tool as `userId`. Returns text for the model. */
export async function callTool(pluginId: string, toolName: string, args: any, userId = currentUserId()): Promise<{ status: number; text: string }> {
  const p = getPlugin(pluginId);
  if (!p) throw new Permanent('That plugin was removed');
  const tool = findTool(p, toolName);
  if (!tool) throw new Permanent(`${p.name} has no tool called ${toolName}`);
  if (p.visibility === 'private' && p.createdBy !== userId) throw new Permanent(`${p.name} is private to its owner`);
  return guarded(p, async () => {
    if (p.kind === 'mcp') {
      const r = await mcpCall(p, userId, 'tools/call', { name: tool.name, arguments: args ?? {} });
      const text = (r?.content ?? []).map((c: any) => c.type === 'text' ? c.text : c.type === 'resource' ? (c.resource?.text ?? c.resource?.uri) : `[${c.type}]`).join('\n')
        || (r?.structuredContent ? JSON.stringify(r.structuredContent) : '');
      if (r?.isError) throw new Permanent(`${p.name} → ${tool.name} failed: ${text.slice(0, 600)}`);
      return { status: 200, text: text.slice(0, MAX_BODY) };
    }
    return httpCall(p, tool, args ?? {}, userId);
  });
}

async function httpCall(p: PluginRow, tool: PluginTool, args: Record<string, any>, userId: string, retried = false): Promise<{ status: number; text: string }> {
  if (!p.config.baseUrl) throw new Permanent(`${p.name} has no base URL`);
  const used = new Set<string>();
  const path = tool.path.replace(/\{(\w+)\}/g, (_, k) => {
    if (args[k] === undefined) throw new Permanent(`Missing "${k}" for ${tool.name}`);
    used.add(k); return encodeURIComponent(String(args[k]));
  });
  const url = new URL(p.config.baseUrl.replace(/\/$/, '') + path);
  const queryKeys = tool.query ?? (['GET', 'DELETE'].includes(tool.method) ? Object.keys(args) : []);
  for (const k of queryKeys) if (args[k] !== undefined && !used.has(k)) { url.searchParams.set(k, typeof args[k] === 'object' ? JSON.stringify(args[k]) : String(args[k])); used.add(k); }
  let body: string | undefined;
  if (!['GET', 'DELETE'].includes(tool.method) || tool.bodyParam) {
    const rest = tool.bodyParam ? args[tool.bodyParam] : Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k)));
    if (rest !== undefined) body = JSON.stringify(rest);
  }
  const token = await credential(p, userId, retried);
  const res = await fetch(url, {
    method: tool.method, signal: AbortSignal.timeout(CALL_TIMEOUT),
    headers: { accept: 'application/json, text/plain, */*', 'user-agent': 'AUDA-Agent', ...(body ? { 'content-type': 'application/json' } : {}), ...(p.config.headers ?? {}), ...authHeaders(p, token) },
    body,
  });
  const text = await res.text();
  if (res.status === 401 && !retried && p.config.auth.type === 'oauth2') return httpCall(p, tool, args, userId, true);
  if (res.status === 401) saveConnection(p.id, userId, { state: 'expired', error: 'The service rejected the credentials' });
  if (!res.ok) throw httpError(p, res.status, text);
  // Some APIs (Slack) report errors inside a 200.
  if (/^\s*\{/.test(text)) { try { const j = JSON.parse(text); if (j && j.ok === false) throw new Permanent(`${p.name} → ${tool.name}: ${j.error ?? 'failed'}`); } catch (e) { if (e instanceof Permanent) throw e; } }
  return { status: res.status, text: text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n…[truncated ${text.length - MAX_BODY} characters]` : text };
}

// ─── MCP (Streamable HTTP) ───────────────────────────────────────────────────

const MCP_PROTOCOL = '2025-06-18';
const mcpSessions = new Map<string, { sessionId?: string; ready: boolean }>();
let rpcSeq = 1;

async function mcpPost(p: PluginRow, userId: string, msg: any, retried = false): Promise<any> {
  const key = `${p.id}:${userId}`;
  const s = mcpSessions.get(key) ?? { ready: false };
  const token = await credential(p, userId, retried);
  const res = await fetch(p.config.mcpUrl!, {
    method: 'POST', signal: AbortSignal.timeout(Math.max(CALL_TIMEOUT, 60_000)),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MCP_PROTOCOL,
      ...(s.sessionId ? { 'mcp-session-id': s.sessionId } : {}), ...(p.config.headers ?? {}), ...authHeaders(p, token) },
    body: JSON.stringify(msg),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) mcpSessions.set(key, { ...s, sessionId: sid });
  if (res.status === 404 && s.sessionId && !retried) { mcpSessions.delete(key); throw Object.assign(new Error('session expired'), { sessionExpired: true }); }
  if (res.status === 401 && !retried && p.config.auth.type === 'oauth2') return mcpPost(p, userId, msg, true);
  if (res.status === 401) {
    if (p.config.auth.type === 'none') throw new Permanent(`${p.name} requires sign-in. Remove it and add it again with "Sign in with OAuth" turned on.`);
    saveConnection(p.id, userId, { state: 'expired', error: 'The MCP server rejected the credentials' });
  }
  if (res.status === 202 || msg.id === undefined) { await res.body?.cancel().catch(() => {}); return undefined; }
  if (!res.ok) throw httpError(p, res.status, await res.text());
  const ct = res.headers.get('content-type') ?? '';
  let reply: any;
  if (ct.includes('text/event-stream')) reply = await readSse(res, msg.id);
  else reply = await res.json();
  if (Array.isArray(reply)) reply = reply.find((r) => r.id === msg.id);
  if (!reply) throw new Transient(`${p.name} closed the stream without answering`);
  if (reply.error) {
    const e = reply.error;
    throw (e.code === -32601 || e.code === -32602) ? new Permanent(`${p.name}: ${e.message}`) : new Error(`${p.name}: ${e.message ?? 'MCP error'}`);
  }
  return reply.result;
}

/** Read an SSE response until the JSON-RPC reply with `id` arrives. */
async function readSse(res: Response, id: number) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const evt = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = evt.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        try { const m = JSON.parse(data); if (m.id === id && (m.result !== undefined || m.error)) return m; } catch { /* not JSON: ignore */ }
      }
    }
  } finally { reader.cancel().catch(() => {}); }
  return undefined;
}

async function mcpCall(p: PluginRow, userId: string, method: string, params: any, attempt = 0): Promise<any> {
  if (!p.config.mcpUrl) throw new Permanent(`${p.name} has no MCP server URL`);
  const key = `${p.id}:${userId}`;
  try {
    if (!mcpSessions.get(key)?.ready) {
      mcpSessions.delete(key);
      await mcpPost(p, userId, { jsonrpc: '2.0', id: rpcSeq++, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'AUDA', version: '0.4.0' } } });
      await mcpPost(p, userId, { jsonrpc: '2.0', method: 'notifications/initialized' });
      mcpSessions.set(key, { ...(mcpSessions.get(key) ?? {}), ready: true });
    }
    return await mcpPost(p, userId, { jsonrpc: '2.0', id: rpcSeq++, method, params });
  } catch (e: any) {
    if (e.sessionExpired && attempt < 1) return mcpCall(p, userId, method, params, attempt + 1);
    throw e;
  }
}

/** Fetch the MCP server's tool list (paginated) and store it on the plugin. */
export async function refreshMcpTools(pluginId: string, userId = currentUserId()) {
  const p = getPlugin(pluginId)!;
  const tools: PluginTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10 && tools.length < MAX_TOOLS; page++) {
    const r = await mcpCall(p, userId, 'tools/list', cursor ? { cursor } : {});
    for (const t of r?.tools ?? []) {
      tools.push({ name: String(t.name), description: String(t.description ?? t.title ?? t.name).slice(0, 1000), method: 'POST', path: '',
        input_schema: { type: 'object', properties: t.inputSchema?.properties ?? {}, required: t.inputSchema?.required ?? [] },
        readOnly: t.annotations?.readOnlyHint === true });
    }
    cursor = r?.nextCursor;
    if (!cursor) break;
  }
  const cfg = p.config;
  cfg.tools = tools.slice(0, MAX_TOOLS);
  update('plugins', pluginId, { config_json: JSON.stringify(cfg) });
  changed('plugin', pluginId);
  return cfg.tools;
}

/**
 * MCP authorization discovery: protected-resource metadata → authorization
 * server metadata → dynamic client registration (public client + PKCE).
 */
export async function discoverAuth(p: PluginRow): Promise<PluginConfig['auth']> {
  const mcp = new URL(p.config.mcpUrl!);
  const getJson = async (u: string) => { const r = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(CALL_TIMEOUT) }); return r.ok ? r.json() as Promise<any> : undefined; };
  let prmUrl: string | undefined;
  try {
    const probe = await fetch(mcp, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":0,"method":"ping"}', signal: AbortSignal.timeout(CALL_TIMEOUT) });
    prmUrl = /resource_metadata="([^"]+)"/.exec(probe.headers.get('www-authenticate') ?? '')?.[1];
    await probe.body?.cancel().catch(() => {});
  } catch { /* fall back to well-known */ }
  const prm = (prmUrl && await getJson(prmUrl).catch(() => undefined))
    ?? await getJson(`${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname === '/' ? '' : mcp.pathname}`).catch(() => undefined)
    ?? await getJson(`${mcp.origin}/.well-known/oauth-protected-resource`).catch(() => undefined);
  const issuer = String(prm?.authorization_servers?.[0] ?? mcp.origin).replace(/\/$/, '');
  const iss = new URL(issuer);
  const tail = iss.pathname === '/' ? '' : iss.pathname;
  const meta = await getJson(`${iss.origin}/.well-known/oauth-authorization-server${tail}`).catch(() => undefined)
    ?? await getJson(`${iss.origin}/.well-known/openid-configuration${tail}`).catch(() => undefined);
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) throw new Permanent(`${p.name} doesn't publish OAuth metadata; add it with a client id or an API key instead`);
  const a: PluginConfig['auth'] = {
    ...p.config.auth, type: 'oauth2', discovered: true, authorizeUrl: meta.authorization_endpoint, tokenUrl: meta.token_endpoint,
    registrationUrl: meta.registration_endpoint, resource: prm?.resource ?? p.config.mcpUrl,
    scopes: p.config.auth.scopes?.length ? p.config.auth.scopes : (prm?.scopes_supported ?? []),
  };
  if (!a.clientId) {
    if (!meta.registration_endpoint) throw new Permanent(`${p.name} needs an OAuth client id (it doesn't support automatic registration). Ask an admin to add one.`);
    const r = await fetch(meta.registration_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: AbortSignal.timeout(CALL_TIMEOUT),
      body: JSON.stringify({ client_name: 'AUDA', redirect_uris: [redirectUri()], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.client_id) throw new Permanent(`${p.name} refused client registration: ${j.error_description ?? j.error ?? `HTTP ${r.status}`}`);
    a.clientId = j.client_id;
    if (j.client_secret) update('plugins', p.id, { client_secret_ref: putSecret(`plugin:${p.id}:client_secret`, j.client_secret) });
  }
  const cfg = { ...p.config, auth: a };
  update('plugins', p.id, { config_json: JSON.stringify(cfg) });
  p.config = cfg;
  return a;
}

// ─── OpenAPI import ──────────────────────────────────────────────────────────

/** Turn an OpenAPI 3 (JSON) document into tools. Accepts a URL or the parsed document. */
export async function importOpenApi(src: string | any): Promise<PluginConfig> {
  let spec = src; let base = '';
  if (typeof src === 'string') {
    base = src;
    const r = await fetch(src, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(CALL_TIMEOUT) });
    if (!r.ok) throw new Permanent(`Couldn't fetch the OpenAPI document (HTTP ${r.status})`);
    const text = await r.text();
    try { spec = JSON.parse(text); } catch { throw new Permanent('Only JSON OpenAPI documents are supported — convert YAML to JSON first'); }
  }
  if (!spec?.paths) throw new Permanent('That is not an OpenAPI document (no "paths")');
  const server = spec.servers?.[0]?.url ?? '';
  const baseUrl = server ? new URL(server, base || 'http://localhost').toString().replace(/\/$/, '') : (base ? new URL(base).origin : '');
  const deref = (o: any): any => {
    if (o?.$ref && typeof o.$ref === 'string' && o.$ref.startsWith('#/')) return o.$ref.slice(2).split('/').reduce((x: any, k: string) => x?.[k], spec);
    return o;
  };
  const tools: PluginTool[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item?.[method];
      if (!op || tools.length >= MAX_TOOLS) continue;
      const props: Record<string, any> = {}; const required: string[] = []; const query: string[] = [];
      for (const prm0 of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        const prm = deref(prm0);
        if (!prm?.name || !['path', 'query'].includes(prm.in)) continue;
        const sch = deref(prm.schema) ?? { type: 'string' };
        props[prm.name] = { type: sch.type ?? 'string', description: prm.description?.slice(0, 200) };
        if (prm.required || prm.in === 'path') required.push(prm.name);
        if (prm.in === 'query') query.push(prm.name);
      }
      let bodyParam: string | undefined;
      const body = deref(deref(op.requestBody)?.content?.['application/json']?.schema);
      if (body?.properties && !Object.keys(body.properties).some((k) => k in props)) {
        for (const [k, v] of Object.entries<any>(body.properties)) { const s = deref(v); props[k] = { type: s?.type ?? 'string', description: s?.description?.slice(0, 200) }; }
        required.push(...(body.required ?? []));
      } else if (body) { props.body = { type: 'object', description: 'JSON request body' }; required.push('body'); bodyParam = 'body'; }
      const name = slug(op.operationId ?? `${method}_${path}`).slice(0, 48) || `${method}_${tools.length}`;
      tools.push({
        name: tools.some((t) => t.name === name) ? `${name}_${tools.length}` : name,
        description: String(op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`).slice(0, 500),
        method: method.toUpperCase() as PluginTool['method'], path, query, bodyParam,
        input_schema: { type: 'object', properties: props, required: [...new Set(required)] }, readOnly: method === 'get',
      });
    }
  }
  let auth: PluginConfig['auth'] = { type: 'none' };
  for (const s0 of Object.values<any>(spec.components?.securitySchemes ?? {})) {
    const s = deref(s0);
    if (s.type === 'oauth2' && s.flows?.authorizationCode) {
      const f = s.flows.authorizationCode;
      auth = { type: 'oauth2', authorizeUrl: new URL(f.authorizationUrl, baseUrl || base).toString(), tokenUrl: new URL(f.tokenUrl, baseUrl || base).toString(), scopes: Object.keys(f.scopes ?? {}) };
      break;
    }
    if (s.type === 'http' && s.scheme === 'bearer') auth = { type: 'bearer' };
    if (s.type === 'apiKey' && s.in === 'header' && auth.type === 'none') auth = { type: 'apiKey', apiKeyHeader: s.name };
  }
  return { baseUrl, auth, tools, docs: spec.info?.title };
}

// ─── agent integration ───────────────────────────────────────────────────────

export interface AgentPluginTool { name: string; description: string; input_schema: any; pluginId: string; plugin: string; tool: string; readOnly: boolean }

/** Tools from plugins this member has connected, optionally restricted to a custom agent's allowed plugins. */
export function agentPluginTools(userId: string, allowed?: string[] | null): AgentPluginTool[] {
  const out: AgentPluginTool[] = [];
  const conns = new Set(q.all("SELECT plugin_id FROM plugin_connections WHERE user_id = ? AND state = 'connected'", userId).map((r) => r.plugin_id));
  for (const p of visiblePlugins(userId)) {
    if (allowed && !allowed.includes(p.id)) continue;
    if (!conns.has(p.id) && p.config.auth.type !== 'none') continue;
    const prefix = `p_${slug(p.preset ?? p.name)}_${p.id.slice(-4)}__`;
    for (const t of p.config.tools) {
      out.push({
        name: (prefix + t.name.replace(/[^a-zA-Z0-9_-]/g, '_')).slice(0, 64),
        description: `[${p.name}${t.readOnly ? '' : ' · changes data, may ask first'}] ${t.description}`.slice(0, 1024),
        input_schema: t.input_schema, pluginId: p.id, plugin: p.name, tool: t.name, readOnly: t.readOnly,
      });
      if (out.length >= 80) return out;
    }
  }
  return out;
}

export function pluginSummary(userId: string) {
  return visiblePlugins(userId).map((p) => ({ id: p.id, name: p.name, connected: connection(p.id, userId)?.state === 'connected' || p.config.auth.type === 'none', tools: p.config.tools.length }));
}

/** Broker implementations: run as whoever the current task (or request) belongs to. */
export function initPlugins() {
  const impl = async (i: any) => callTool(i.pluginId, i.tool, i.args ?? {}, currentUserId());
  registerTool('plugin.read', impl);
  registerTool('plugin.write', impl);
}
