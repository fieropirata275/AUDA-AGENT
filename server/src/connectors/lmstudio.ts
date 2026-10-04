/**
 * LM Studio connector. LM Studio's headless server (`lms server start`,
 * default port 1234) speaks the OpenAI chat API with tool calling, so AUDA's
 * agents can run entirely on local models.
 *
 *  - Detection: probes the usual addresses at boot and every few minutes, and
 *    tells you when it finds a server (it never switches models on its own).
 *  - Connect: lists models (load state, context length), runs a real
 *    tool-calling probe on the chosen model, and records whether the model can
 *    drive agents or should only be used for text tasks.
 *  - Health: keeps checking the server; a circuit breaker stops hammering it if
 *    it goes away, and tasks retry when it comes back.
 */
import os from 'node:os';
import { getSetting, now, q, setSetting } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { activity } from '../core/activity.ts';
import { log } from '../core/log.ts';
import { ensureConnector, setConnector } from './runtime.ts';
import { chat, listModels } from '../models/openai.ts';
import { modelSettings, type Role } from '../models/router.ts';
import { putSecret, deleteSecret, resolveSecret } from '../secrets/broker.ts';
import { notify } from '../notifications/service.ts';

export function candidates(): string[] {
  const set = new Set<string>();
  const cfg = modelSettings().local?.baseUrl;
  if (cfg) set.add(cfg);
  for (const u of (process.env.LMSTUDIO_URL ?? '').split(',').filter(Boolean)) set.add(u);
  for (const h of ['127.0.0.1', 'localhost', 'host.docker.internal']) set.add(`http://${h}:1234`);
  // A gateway host is a common place for LM Studio when AUDA runs in a VM/container.
  for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs ?? []) {
    if (i.family === 'IPv4' && !i.internal) set.add(`http://${i.address.split('.').slice(0, 3).join('.')}.1:1234`);
  }
  return [...set];
}

export async function detect() {
  const found: { baseUrl: string; flavor: string; models: any[] }[] = [];
  await Promise.all(candidates().map(async (baseUrl) => {
    try {
      const r = await listModels(baseUrl, resolveSecret(modelSettings().local?.apiKeySecret));
      if (!found.some((f) => f.models.length === r.models.length && f.flavor === r.flavor && f.baseUrl.includes('127.0.0.1') && baseUrl.includes('localhost'))) found.push({ baseUrl, ...r });
    } catch { /* nothing there */ }
  }));
  return found.sort((a, b) => Number(b.flavor === 'lmstudio') - Number(a.flavor === 'lmstudio'));
}

/** Ask the model to call a tool. Many small local models can't; agents need it. */
export async function probeTools(baseUrl: string, model: string, apiKey?: string) {
  const t0 = now();
  try {
    const r = await chat({ baseUrl, model, apiKey, tools: true }, {
      system: 'You are a function-calling test. Always use the provided tool.',
      messages: [{ role: 'user', content: 'Call the report tool with status set to "ok" and count set to 3.' }],
      tools: [{ name: 'report', description: 'Report a status', input_schema: { type: 'object', properties: { status: { type: 'string' }, count: { type: 'number' } }, required: ['status', 'count'] } }],
      maxTokens: 300, temperature: 0,
    });
    const call = r.content.find((b) => b.type === 'tool_use');
    return { ok: true, tools: Boolean(call && call.input?.status), ms: now() - t0, sample: call ? JSON.stringify(call.input) : r.content.find((b) => b.type === 'text')?.text?.slice(0, 160) };
  } catch (e) {
    return { ok: false, tools: false, ms: now() - t0, error: (e as Error).message };
  }
}

export async function connect(o: { baseUrl: string; model: string; roles: Role[]; apiKey?: string; contextLength?: number }) {
  const list = await listModels(o.baseUrl, o.apiKey).catch((e) => { throw new Error(`Couldn’t reach ${o.baseUrl}: ${(e as Error).message}`); });
  const info = list.models.find((m: any) => m.id === o.model);
  if (!info) throw new Error(`${o.model} isn’t available on that server`);
  const probe = await probeTools(o.baseUrl, o.model, o.apiKey);
  if (!probe.ok) throw new Error(`The model didn’t answer: ${probe.error}`);
  const cur = getSetting<any>('models', {});
  if (cur.local?.apiKeySecret && o.apiKey !== undefined) deleteSecret(cur.local.apiKeySecret);
  const roles = { ...modelSettings().roles };
  for (const r of o.roles) roles[r] = { provider: 'local', model: o.model };
  setSetting('models', {
    ...cur, roles,
    local: { baseUrl: o.baseUrl.replace(/\/+$/, ''), model: o.model, kind: list.flavor, tools: probe.tools, contextLength: o.contextLength ?? info.contextLength, apiKeySecret: o.apiKey ? putSecret('local-model-key', o.apiKey) : cur.local?.apiKeySecret },
  });
  changed('settings', 'settings');
  const detail = `${o.model} · ${probe.tools ? 'tool calling ✓' : 'text only — agents need a tool-calling model'}${info.contextLength ? ` · ${Math.round(info.contextLength / 1024)}k context` : ''}`;
  ensureConnector('lmstudio', 'LM Studio', 'connected');
  setConnector('lmstudio', { state: 'connected', detail, error: null, last_ok_at: now(), config_json: JSON.stringify({ baseUrl: o.baseUrl, model: o.model, roles: o.roles, tools: probe.tools }) });
  activity('user', `Connected ${list.flavor === 'lmstudio' ? 'LM Studio' : 'a local model server'}: ${o.model}`, { detail: `${detail}. Used for: ${o.roles.join(', ')}. Probe answered in ${(probe.ms / 1000).toFixed(1)} s.` });
  return { ...probe, flavor: list.flavor };
}

export function disconnect() {
  const cur = getSetting<any>('models', {});
  const roles = { ...modelSettings().roles };
  for (const r of Object.keys(roles) as Role[]) if (roles[r].provider === 'local') roles[r] = r === 'fallback' ? { provider: 'local', model: '' } : { provider: 'anthropic', model: r === 'utility' ? 'claude-haiku-4-5' : 'claude-opus-5-5' };
  setSetting('models', { ...cur, roles, local: undefined });
  setConnector('lmstudio', { state: 'disconnected', detail: null, error: null });
  changed('settings', 'settings');
}

let announced = false;
async function healthAndDiscovery() {
  const local = modelSettings().local;
  try {
    if (local?.baseUrl) {
      const r = await listModels(local.baseUrl, resolveSecret(local.apiKeySecret));
      const m = r.models.find((x: any) => x.id === local.model);
      const row = q.get("SELECT state FROM connectors WHERE id = 'lmstudio'");
      const detail = `${local.model} · ${m ? (m.state === 'loaded' ? 'loaded' : m.state === 'not-loaded' ? 'not loaded (LM Studio loads it on first use)' : 'available') : 'model missing on server!'} · ${local.tools ? 'tool calling ✓' : 'text only'}`;
      setConnector('lmstudio', { state: m ? 'connected' : 'degraded', detail, error: m ? null : `${local.model} is no longer on the server`, last_ok_at: now() });
      if (row?.state === 'error' || row?.state === 'degraded') activity('recover', 'LM Studio is reachable again', { detail });
    } else {
      const found = await detect();
      const lm = found.find((f) => f.flavor === 'lmstudio') ?? found[0];
      if (lm) {
        setConnector('lmstudio', { state: 'available', detail: `Found at ${lm.baseUrl} · ${lm.models.filter((m) => m.type !== 'embeddings').length} models`, config_json: JSON.stringify({ found: lm.baseUrl }) });
        if (!announced) { announced = true; notify('fyi', 'Found LM Studio on this machine', `${lm.baseUrl} · connect it in Connections to run AUDA on local models.`); }
      }
    }
  } catch (e) {
    if (local?.baseUrl) setConnector('lmstudio', { state: 'error', error: `Not reachable at ${local.baseUrl}: ${(e as Error).message}. Is \`lms server start\` running?` });
    else log.warn('lmstudio discovery failed', String(e));
  }
}

export function initLmStudio() {
  ensureConnector('lmstudio', 'LM Studio', 'disconnected');
  setTimeout(() => void healthAndDiscovery(), 3000);
  setInterval(() => void healthAndDiscovery(), 60_000);
}
