import https from 'node:https';
/** Proxmox VE connection and agent VM lifecycle.
 * Credentials remain in AUDA's encrypted secret broker, never in model context.
 * Only owner/admin setup endpoints should call connect().
 */
import { q, getSetting, setSetting, now } from '../core/db.ts';
import { putSecret, resolveSecret, deleteSecret } from '../secrets/broker.ts';
import { ensureConnector, setConnector } from './runtime.ts';

export interface ProxmoxConfig { url: string; tokenId: string; secretRef: string; node: string; template: number; storage?: string; bridge?: string; insecureTls?: boolean; }
export interface VmSpec { agentId: string; name?: string; cores?: number; memoryMiB?: number; }
export interface AgentVm { agentId: string; vmid: number; node: string; state: 'provisioned' | 'running' | 'suspended'; }
const KEY = 'proxmox.agentVms';
const cfg = (): ProxmoxConfig | null => getSetting<ProxmoxConfig | null>('proxmox.config', null);
const registry = (): Record<string, AgentVm> => getSetting<Record<string, AgentVm>>(KEY, {});
const commit = (r: Record<string, AgentVm>) => setSetting(KEY, r);
function endpoint(raw: string, insecureTls = false) {
  const u = new URL(raw.trim());
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Enter a clean HTTP(S) Proxmox URL');
  if (u.protocol === 'http:' && !insecureTls) throw new Error('HTTP requires explicitly enabling the local insecure connection option');
  return u.origin + '/api2/json';
}
/** TLS exception is isolated to this one Proxmox endpoint. Never changes global Node TLS settings. */
async function insecureLocalFetch(url: string, init: {method: string; headers: Record<string,string>; body?: URLSearchParams; signal: AbortSignal}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: init.method, headers: init.headers, rejectUnauthorized: false, timeout: 20_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), {status: res.statusCode ?? 500, headers: res.headers as Record<string,string>})));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Proxmox connection timed out')));
    init.signal.addEventListener('abort', () => req.destroy(new Error('Proxmox connection cancelled')), {once: true});
    req.end(init.body?.toString());
  });
}
export async function request<T = any>(config: ProxmoxConfig, method: 'GET' | 'POST', route: string, fields?: Record<string, string | number>) {
  const secret = resolveSecret(config.secretRef);
  if (!secret) throw new Error('Proxmox token is missing: reconnect');
  const url = endpoint(config.url, config.insecureTls) + route;
  const params = {
    method, headers: { Authorization: `PVEAPIToken=${config.tokenId}=${secret}`, ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: fields ? new URLSearchParams(Object.entries(fields).map(([k,v]) => [k, String(v)])) : undefined,
    signal: AbortSignal.timeout(20_000),
  };
  const response = config.insecureTls && url.startsWith('https:') ? await insecureLocalFetch(url, params) : await fetch(url, params);
  const payload = await response.json().catch(() => ({})) as { data?: T; errors?: any; message?: string };
  if (!response.ok) throw new Error(`Proxmox ${response.status}: ${JSON.stringify(payload.errors ?? payload.message ?? 'request failed')}`);
  return payload.data as T;
}
export async function connect(input: { url: string; tokenId: string; tokenSecret: string; insecureTls?: boolean }) {
  endpoint(input.url, Boolean(input.insecureTls));
  if (!/^\S+@\S+!.+/.test(input.tokenId) || !input.tokenSecret.trim()) throw new Error('Provide a Proxmox API token ID (user@realm!token) and secret');
  const existing = cfg();
  const secretRef = putSecret('proxmox-api-token', input.tokenSecret.trim());
  const c: ProxmoxConfig = { url: input.url.trim(), tokenId: input.tokenId.trim(), secretRef, node: '', template: 0, insecureTls: Boolean(input.insecureTls) };
  try {
    const nodes = await request<Array<{node: string; status: string}>>(c, 'GET', '/nodes');
    const node = nodes.find(n => n.status === 'online')?.node;
    if (!node) throw new Error('No online Proxmox node was found');
    const resources = await request<Array<{type: string; vmid?: number; node?: string; name?: string; template?: number | string}>>(c, 'GET', '/cluster/resources?type=vm');
    const templates = resources.filter(x => x.type === 'qemu' && Number(x.template) === 1 && x.node && Number(x.vmid) > 0);
    const first = templates[0];
    if (!first) throw new Error('No visible QEMU template was returned by the Proxmox API. Check the API token VM.Audit permission on /vms and verify template 105 appears in /cluster/resources?type=vm.');
    c.node = first.node!; c.template = Number(first.vmid);
    setSetting('proxmox.config', c);
    ensureConnector('proxmox', 'Proxmox VE', 'connected', `Connected to ${c.node}`);
    setConnector('proxmox', { state: 'connected', detail: `Ready: ${c.node}, template ${c.template}`, last_ok_at: now() });
    if (existing?.secretRef) deleteSecret(existing.secretRef);
    return { connected: true, node: c.node, template: c.template, templateCount: templates.length };
  } catch (e) { deleteSecret(secretRef); throw e; }
}
export async function status() {
  const c = cfg();
  if (!c) return { connected: false, vms: [] };
  const nodes = await request<Array<{ node: string; status: string }>>(c, 'GET', '/nodes');
  return { connected: true, node: c.node, template: c.template, online: nodes.some(n => n.node === c.node && n.status === 'online'), vms: Object.values(registry()) };
}
function requireConfig() { const c = cfg(); if (!c) throw new Error('Proxmox is not connected'); return c; }
function validAgent(agentId: string) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(agentId)) throw new Error('Invalid agent ID');
  return agentId;
}
/** Do not hand a still-cloning VM to an agent. Proxmox returns UPIDs for async operations. */
export async function awaitTask(c: ProxmoxConfig, node: string, upid: string, deadlineMs = 180_000) {
  if (typeof upid !== 'string' || !upid.startsWith('UPID:')) throw new Error('Expected Proxmox UPID for asynchronous operation');
  const route = `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`;
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    const task = await request<{ status: string; exitstatus?: string }>(c, 'GET', route);
    if (task.status === 'stopped') {
      if (task.exitstatus !== 'OK') throw new Error(`Proxmox task failed: ${task.exitstatus ?? 'unknown'}`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error('Proxmox task did not finish before the deadline; check the Proxmox task log before retrying');
}
export async function provision(spec: VmSpec): Promise<AgentVm> {
  const c = requireConfig(), id = validAgent(spec.agentId);
  const saved = registry()[id]; if (saved) return saved;
  const cores = Math.max(1, Math.min(8, Math.trunc(spec.cores ?? 2)));
  const memory = Math.max(1024, Math.min(16384, Math.trunc(spec.memoryMiB ?? 4096)));
  const next = await request<string | number>(c, 'GET', '/cluster/nextid');
  const vmid = Number(next);
  if (!Number.isInteger(vmid) || vmid <= 0) throw new Error('Proxmox returned an invalid VMID');
  // Clone from an existing admin-prepared QEMU template; Proxmox does not install the guest OS.
  const upid = await request<string>(c, 'POST', `/nodes/${encodeURIComponent(c.node)}/qemu/${c.template}/clone`, {
    newid: vmid, name: (spec.name ?? `auda-${id}`).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60), full: 1,
  });
  await awaitTask(c, c.node, upid);
  await request(c, 'POST', `/nodes/${encodeURIComponent(c.node)}/qemu/${vmid}/config`, { cores, memory, agent: 1 });
  const vm: AgentVm = { agentId: id, vmid, node: c.node, state: 'provisioned' };
  const r = registry(); r[id] = vm; commit(r);
  // Proxmox cloning can be asynchronous; starting should only occur after task completion.
  return vm;
}
export async function power(agentId: string, action: 'start'|'suspend'|'resume') {
  const c = requireConfig(), id = validAgent(agentId), r = registry(), vm = r[id];
  if (!vm) throw new Error('No VM assigned to this agent');
  const actual = await request<{status: string; qmpstatus?: string}>(c, 'GET', `/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.vmid}/status/current`);
  if (action === 'start' && actual.status === 'running') return vm;
  if (action === 'resume' && actual.status === 'running' && actual.qmpstatus === 'running') return vm;
  if (action === 'suspend' && actual.qmpstatus === 'paused') return vm;
  const upid = await request<string>(c, 'POST', `/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.vmid}/status/${action}`);
  await awaitTask(c, vm.node, upid);
  vm.state = action === 'suspend' ? 'suspended' : 'running'; commit(r);
  return vm;
}

/** Execute commands INSIDE the allocated VM through QEMU Guest Agent.
 * The template must have qemu-guest-agent installed and active. No SSH keys required.
 */
export async function guestExec(agentId: string, command: string, timeoutMs = 120_000) {
  const c = requireConfig(), vm = registry()[validAgent(agentId)];
  if (!vm) throw new Error('This agent has no allocated Proxmox VM');
  if (vm.state !== 'running') throw new Error('Agent VM must be running before executing commands');
  const base = `/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.vmid}/agent`;
  const started = Date.now();
  const launch = await request<{pid: number}>(c, 'POST', base + '/exec', { command: '/bin/sh', 'extra-args': JSON.stringify(['-lc', command]) });
  if (!Number.isInteger(launch.pid)) throw new Error('Guest agent did not return a process ID');
  while (Date.now() - started < timeoutMs) {
    const r = await request<{exited: boolean; exitcode?: number; 'out-data'?: string; 'err-data'?: string}>(c, 'GET', base + '/exec-status?pid=' + launch.pid);
    if (r.exited) return { code: r.exitcode ?? -1, stdout: Buffer.from(r['out-data'] ?? '', 'base64').toString('utf8'), stderr: Buffer.from(r['err-data'] ?? '', 'base64').toString('utf8'), durationMs: Date.now() - started, timedOut: false };
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Guest command exceeded its timeout (the guest process may still be running)');
}
export async function ensureAgentVm(agentId: string) {
  const id = validAgent(agentId);
  let vm = registry()[id];
  if (!vm) vm = await provision({ agentId: id });
  if (vm.state === 'provisioned') await power(id, 'start');
  else if (vm.state === 'suspended') await power(id, 'resume');
  return registry()[id];
}
export async function parkAgentVm(agentId: string) {
  const vm = registry()[validAgent(agentId)];
  if (!vm || vm.state !== 'running') return vm ?? null;
  return power(agentId, 'suspend');
}
export function isEnabled() { return Boolean(cfg()); }

/** Serialized per-agent VM operations. Works across simultaneous task turns in this
 * process. A database/cluster lease is required before multi-core deployments.
 */
const queues = new Map<string, Promise<unknown>>();
export async function withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const id = validAgent(agentId), previous = queues.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.catch(() => {}).then(() => gate);
  queues.set(id, current);
  await previous.catch(() => {});
  try { return await fn(); }
  finally { release(); if (queues.get(id) === current) queues.delete(id); }
}
export async function runInVm(agentId: string, cmd: string, timeoutMs = 120_000) {
  return withAgentLock(agentId, async () => {
    await ensureAgentVm(agentId);
    return guestExec(agentId, cmd, timeoutMs);
  });
}
export async function parkIfIdle(agentId: string) {
  return withAgentLock(agentId, async () => {
    const active = q.get("SELECT COUNT(*) n FROM tasks WHERE agent_id = ? AND state IN ('RUNNING','READY','PLANNING','RECOVERING')", agentId)?.n ?? 0;
    if (active) return null;
    return parkAgentVm(agentId);
  });
}
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
function safePath(p: string) {
  if (!p || p.startsWith('/') || p.split('/').some(x => x === '..' || x === '') || /[\\\\\x00-\x1f]/.test(p))
    throw new Error('Guest file path must be relative to the agent home and cannot contain ..');
  return '/home/auda/' + p.replace(/^\.\//, '');
}
export async function guestRead(agentId: string, file: string) {
  const r = await runInVm(agentId, 'base64 -w0 -- ' + quote(safePath(file)));
  if (r.code) throw new Error(r.stderr || 'Cannot read file');
  return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
}
export async function guestWrite(agentId: string, file: string, text: string) {
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Use smaller file chunks (256 KiB max)');
  const target = safePath(file);
  const b64 = Buffer.from(text,'utf8').toString('base64');
  const r = await runInVm(agentId, 'mkdir -p -- ' + quote(target.slice(0,target.lastIndexOf('/'))) + ' && printf %s ' + quote(b64) + ' | base64 -d > ' + quote(target));
  if (r.code) throw new Error(r.stderr || 'Cannot write file');
  return { path: file, size: Buffer.byteLength(text) };
}
export async function guestList(agentId: string, directory = '.') {
  const p = directory === '.' ? '/home/auda' : safePath(directory);
  const r = await runInVm(agentId, 'ls -la -- ' + quote(p));
  if (r.code) throw new Error(r.stderr);
  return r.stdout;
}
export async function guestSearch(agentId: string, directory: string, pattern: string) {
  const p = directory === '.' ? '/home/auda' : safePath(directory);
  const r = await runInVm(agentId, 'grep -rnE -- ' + quote(pattern) + ' ' + quote(p), 60_000);
  if (r.code > 1) throw new Error(r.stderr);
  return r.stdout.slice(0,64000);
}
/** GUI requires an installed graphical session + xdotool/ImageMagick inside the guest.
 * The guest owns its display; host input is never forwarded implicitly.
 */
export async function desktopAction(agentId: string, action: 'screenshot'|'click'|'type'|'key', data: {x?:number;y?:number;text?:string;key?:string} = {}) {
  let cmd: string;
  if (action === 'screenshot') cmd = 'DISPLAY=:0 import -window root png:- | base64 -w0';
  else if (action === 'click') {
    const x = Math.trunc(data.x ?? NaN), y = Math.trunc(data.y ?? NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10000 || y > 10000) throw new Error('Invalid screen coordinates');
    cmd = `DISPLAY=:0 xdotool mousemove ${x} ${y} click 1`;
  } else if (action === 'type') cmd = 'DISPLAY=:0 xdotool type --clearmodifiers -- ' + quote(String(data.text ?? '').slice(0,4000));
  else cmd = 'DISPLAY=:0 xdotool key -- ' + quote(String(data.key ?? '').slice(0,80));
  const r = await runInVm(agentId, cmd, 60_000);
  if (r.code) throw new Error(r.stderr || 'Desktop is unavailable: install a graphical session, xdotool and ImageMagick');
  return action === 'screenshot' ? { pngBase64: r.stdout.trim() } : { ok: true };
}
