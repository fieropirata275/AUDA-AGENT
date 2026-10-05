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
import { hasReasoningModel, modelSettings, type Role } from '../models/router.ts';
import { putSecret, deleteSecret, resolveSecret } from '../secrets/broker.ts';
import { notify } from '../notifications/service.ts';
import { detectHardware } from './hardware.ts';
import { isLocalUrl, liveState, lmsBinary, runSetup, setupState, startServer, type ConnectArgs } from './lmstudio-setup.ts';

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

export async function connect(o: ConnectArgs) {
  const list = await listModels(o.baseUrl, o.apiKey ?? resolveSecret(modelSettings().local?.apiKeySecret)).catch((e) => { throw new Error((e as any).auth ? (e as Error).message : `Couldn’t reach ${o.baseUrl}: ${(e as Error).message}`); });
  const info = list.models.find((m) => m.id === o.model);
  if (!info) throw new Error(`${o.model} isn’t available on that server`);
  const probe = o.probe ?? await probeTools(o.baseUrl, o.model, o.apiKey ?? resolveSecret(modelSettings().local?.apiKeySecret));
  if (!probe.ok) throw new Error(`The model didn’t answer: ${probe.error}`);
  const cur = getSetting<any>('models', {});
  if (cur.local?.apiKeySecret && o.apiKey !== undefined) deleteSecret(cur.local.apiKeySecret);
  const roles = { ...modelSettings().roles };
  for (const r of o.roles as Role[]) roles[r] = { provider: 'local', model: o.model };
  // The window agents get: what's loaded, else what AUDA will load (32k at most), else the model's limit.
  const contextLength = o.contextLength ?? info.loadedContext ?? (list.api === 'v1' && info.contextLength ? Math.min(info.contextLength, 32_768) : info.contextLength);
  setSetting('models', {
    ...cur, roles,
    local: { manage: true, api: list.api, ...(o.extra ?? {}), baseUrl: o.baseUrl.replace(/\/+$/, ''), model: o.model, kind: list.flavor, tools: probe.tools, contextLength, apiKeySecret: o.apiKey ? putSecret('local-model-key', o.apiKey) : cur.local?.apiKeySecret },
  });
  liveState.loaded = info.state === 'loaded' || !!o.extra; liveState.context = contextLength;
  changed('settings', 'settings');
  const detail = `${o.model} · ${probe.tools ? 'tool calling ✓' : 'text only — agents need a tool-calling model'}${contextLength ? ` · ${Math.round(contextLength / 1024)}k context` : ''}${o.extra?.tps ? ` · ~${o.extra.tps} tok/s` : ''}`;
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
  setSetting('lmstudio.autoDone', true); // a deliberate disconnect is never undone by first-run setup
  setConnector('lmstudio', { state: 'disconnected', detail: null, error: null });
  changed('settings', 'settings');
}

let announced = false, lastStart = 0;

/** First run: nothing configured anywhere → set up LM Studio on our own, once. */
function autoEligible() {
  return process.env.AUDA_LMSTUDIO_AUTO !== '0' && !process.env.AUDA_MOCK_MODEL && !hasReasoningModel() && !modelSettings().local?.baseUrl
    && !getSetting('lmstudio.autoDone', false) && !setupState()?.running;
}
async function autoSetup(reason: string) {
  log.info(`LM Studio auto-setup: ${reason}`);
  const r = await runSetup({ auto: true });
  if (r.outcome === 'no-server') return; // try again when one appears
  setSetting('lmstudio.autoDone', true);
  if (r.outcome === 'connected' || r.outcome === 'text-only') notify('fyi', r.outcome === 'connected' ? `AUDA is running on ${r.result!.model}` : `Connected ${r.result!.model} for text tasks`, `${r.message} Change it any time in Connections → LM Studio.`);
  else if (r.outcome === 'needs-model') notify('attention', 'LM Studio is ready — it needs one model', `${r.message} One click in Connections → LM Studio.`);
  else if (r.outcome === 'failed') notify('fyi', 'Couldn’t finish setting up LM Studio', `${r.message} Try again from Connections → LM Studio.`);
}

let checking = false;
async function healthAndDiscovery() {
  if (checking) return;
  checking = true;
  try { await check(); } finally { checking = false; }
}

async function check() {
  const local = modelSettings().local;
  try {
    if (local?.baseUrl) {
      const r = await listModels(local.baseUrl, resolveSecret(local.apiKeySecret));
      const m = r.models.find((x) => x.id === local.model);
      liveState.loaded = m ? m.state === 'loaded' : undefined; liveState.context = m?.loadedContext ?? liveState.context; liveState.at = now();
      const row = q.get("SELECT state FROM connectors WHERE id = 'lmstudio'");
      const ctx = m?.loadedContext ? ` · ${Math.round(m.loadedContext / 1024)}k context` : '';
      const detail = `${local.model} · ${m ? (m.state === 'loaded' ? `loaded${ctx}` : m.state === 'not-loaded' ? (local.manage !== false && r.api === 'v1' ? 'not loaded — AUDA loads it when there’s work' : 'not loaded (LM Studio loads it on first use)') : 'available') : 'model missing on server!'} · ${local.tools ? 'tool calling ✓' : 'text only'}${local.tps ? ` · ~${local.tps} tok/s` : ''}`;
      setConnector('lmstudio', { state: m ? 'connected' : 'degraded', detail, error: m ? null : `${local.model} is no longer on the server`, last_ok_at: now() });
      // New GPU, more RAM, a different machine: the plan for the old one may no longer be the best.
      if (isLocalUrl(local.baseUrl)) {
        const hw = await detectHardware();
        const was = getSetting<string>('lmstudio.hwFingerprint', '');
        if (was && was !== hw.fingerprint && getSetting('lmstudio.hwNotified', '') !== hw.fingerprint) {
          setSetting('lmstudio.hwNotified', hw.fingerprint);
          notify('attention', 'Your hardware changed', `AUDA now sees ${hw.summary}. Run setup again in Connections → LM Studio for a model planned for it.`);
        }
      }
      if (row?.state === 'error' || row?.state === 'degraded') activity('recover', 'LM Studio is reachable again', { detail });
    } else {
      const found = await detect();
      const lm = found.find((f) => f.flavor === 'lmstudio') ?? found[0];
      if (lm) {
        setConnector('lmstudio', { state: 'available', detail: `Found at ${lm.baseUrl} · ${lm.models.filter((m) => m.type !== 'embeddings').length} models`, config_json: JSON.stringify({ found: lm.baseUrl }) });
        if (autoEligible()) void autoSetup(`found ${lm.baseUrl}`);
        else if (!announced) { announced = true; notify('fyi', 'Found LM Studio on this machine', `${lm.baseUrl} · connect it in Connections to run AUDA on local models.`); }
      } else if (lmsBinary() && autoEligible()) {
        setConnector('lmstudio', { state: 'available', detail: 'LM Studio is installed here — starting its server' });
        void autoSetup('lms is installed but no server is running');
      }
    }
  } catch (e) {
    if (local?.baseUrl) {
      liveState.loaded = undefined;
      // Keep a managed local server running.
      if (local.manage !== false && isLocalUrl(local.baseUrl) && lmsBinary() && now() - lastStart > 120_000 && getSetting('lmstudio.heal', true)) {
        lastStart = now();
        try {
          await startServer(local.baseUrl, resolveSecret(local.apiKeySecret));
          activity('recover', 'Restarted LM Studio’s server', { detail: `It had stopped at ${local.baseUrl}; AUDA started it again.` });
          return void check();
        } catch (se) { log.warn('could not restart LM Studio', String(se)); }
      }
      setConnector('lmstudio', { state: 'error', error: (e as any).auth ? (e as Error).message : `Not reachable at ${local.baseUrl}: ${(e as Error).message}. Is \`lms server start\` running?` });
    }
    else log.warn('lmstudio discovery failed', String(e));
  }
}

export const refreshLmStudio = () => healthAndDiscovery();

export function initLmStudio() {
  ensureConnector('lmstudio', 'LM Studio', 'disconnected');
  setTimeout(() => void healthAndDiscovery(), Math.min(3000, Number(process.env.AUDA_LMSTUDIO_POLL_MS ?? 3000)));
  setInterval(() => void healthAndDiscovery(), Number(process.env.AUDA_LMSTUDIO_POLL_MS ?? 60_000));
}
