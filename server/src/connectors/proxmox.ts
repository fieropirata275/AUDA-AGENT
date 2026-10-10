/** Proxmox VE connection and agent VM lifecycle.
 * Credentials remain in AUDA's encrypted secret broker, never in model context.
 * Only owner/admin setup endpoints should call connect().
 */
import { q, getSetting, setSetting, now } from '../core/db.ts';
import { putSecret, resolveSecret, deleteSecret } from '../secrets/broker.ts';
import { ensureConnector, setConnector } from './runtime.ts';

export interface ProxmoxConfig { url: string; tokenId: string; secretRef: string; node: string; template: number; storage?: string; bridge?: string; }
export interface VmSpec { agentId: string; name?: string; cores?: number; memoryMiB?: number; }
export interface AgentVm { agentId: string; vmid: number; node: string; state: 'provisioned' | 'running' | 'suspended'; }
const KEY = 'proxmox.agentVms';
const cfg = (): ProxmoxConfig | null => getSetting<ProxmoxConfig | null>('proxmox.config', null);
const registry = (): Record<string, AgentVm> => getSetting<Record<string, AgentVm>>(KEY, {});
const commit = (r: Record<string, AgentVm>) => setSetting(KEY, r);
function endpoint(raw: string) {
  const u = new URL(raw.trim());
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('Proxmox requires a clean HTTPS server URL');
  return u.origin + '/api2/json';
}
export async function request<T = any>(config: ProxmoxConfig, method: 'GET' | 'POST', route: string, fields?: Record<string, string | number>) {
  const secret = resolveSecret(config.secretRef);
  if (!secret) throw new Error('Proxmox token is missing: reconnect');
  const url = endpoint(config.url) + route;
  const response = await fetch(url, {
    method, headers: { Authorization: `PVEAPIToken=${config.tokenId}=${secret}`, ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: fields ? new URLSearchParams(Object.entries(fields).map(([k,v]) => [k, String(v)])) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({})) as { data?: T; errors?: any; message?: string };
  if (!response.ok) throw new Error(`Proxmox ${response.status}: ${JSON.stringify(payload.errors ?? payload.message ?? 'request failed')}`);
  return payload.data as T;
}
export async function connect(input: { url: string; tokenId: string; tokenSecret: string }) {
  endpoint(input.url);
  if (!/^\S+@\S+!.+/.test(input.tokenId) || !input.tokenSecret.trim()) throw new Error('Provide a Proxmox API token ID (user@realm!token) and secret');
  const existing = cfg();
  const secretRef = putSecret('proxmox-api-token', input.tokenSecret.trim());
  const c: ProxmoxConfig = { url: input.url.trim(), tokenId: input.tokenId.trim(), secretRef, node: '', template: 0 };
  try {
    const nodes = await request<Array<{node: string; status: string}>>(c, 'GET', '/nodes');
    const node = nodes.find(n => n.status === 'online')?.node;
    if (!node) throw new Error('No online Proxmox node was found');
    const resources = await request<Array<{type: string; vmid?: number; node?: string; name?: string; template?: number}>>(c, 'GET', '/cluster/resources?type=vm');
    const templates = resources.filter(x => x.type === 'qemu' && x.template === 1 && x.node && x.vmid);
    const first = templates[0];
    if (!first) throw new Error('No QEMU VM template found. Create a cloud-init template in Proxmox first.');
    c.node = first.node!; c.template = first.vmid!;
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
export async function provision(spec: VmSpec): Promise<AgentVm> {
  const c = requireConfig(), id = validAgent(spec.agentId);
  const saved = registry()[id]; if (saved) return saved;
  const cores = Math.max(1, Math.min(8, Math.trunc(spec.cores ?? 2)));
  const memory = Math.max(1024, Math.min(16384, Math.trunc(spec.memoryMiB ?? 4096)));
  const next = await request<{vmid: number} | number>(c, 'GET', '/cluster/nextid');
  const vmid = Number(next);
  if (!Number.isInteger(vmid) || vmid <= 0) throw new Error('Proxmox returned an invalid VMID');
  // Clone from an existing admin-prepared QEMU template; Proxmox does not install the guest OS.
  await request(c, 'POST', `/nodes/${encodeURIComponent(c.node)}/qemu/${c.template}/clone`, {
    newid: vmid, name: (spec.name ?? `auda-${id}`).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60), full: 1,
  });
  const vm: AgentVm = { agentId: id, vmid, node: c.node, state: 'provisioned' };
  const r = registry(); r[id] = vm; commit(r);
  // Proxmox cloning can be asynchronous; starting should only occur after task completion.
  return vm;
}
export async function power(agentId: string, action: 'start'|'suspend'|'resume') {
  const c = requireConfig(), id = validAgent(agentId), r = registry(), vm = r[id];
  if (!vm) throw new Error('No VM assigned to this agent');
  await request(c, 'POST', `/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.vmid}/status/${action}`);
  vm.state = action === 'suspend' ? 'suspended' : 'running'; commit(r);
  return vm;
}
