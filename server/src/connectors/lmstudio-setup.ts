/**
 * Zero-touch LM Studio. Gets AUDA from "nothing configured" to "an agent is
 * running on a local model" with as few decisions as possible, and keeps it
 * there:
 *
 *  - Hardware: RAM, NVIDIA VRAM or Apple unified memory → a memory budget.
 *  - Choice: ranks the models on the server (tool calling, fits in memory,
 *    context, already loaded) and suggests a download sized for this machine
 *    when nothing suitable is there.
 *  - Control: starts LM Studio's server with the `lms` CLI when it's on this
 *    machine, downloads and loads models through LM Studio's v1 REST API
 *    (0.4+), and loads with a context length agents can actually work in —
 *    instead of a just-in-time load with a small default.
 *  - Setup: one orchestrated run (find → server → model → load → tools → speed
 *    → connect) with live progress, used by the one-click button and, once, on
 *    first run when no model is configured at all.
 *  - Healing: a stopped server is restarted, an evicted model is reloaded, and
 *    a context overflow reloads the model with a larger window — once each,
 *    single-flight, and logged in Activity.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSetting, now, setSetting } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { activity } from '../core/activity.ts';
import { log } from '../core/log.ts';
import { chat, listModels, type LocalModel } from '../models/openai.ts';
import { hasReasoningModel, modelSettings } from '../models/router.ts';
import { detectHardware, type Hardware } from './hardware.ts';
import { CATALOG, bestOf, planDownloads, rankInstalled, type Calibration, type LoadSettings, type Option, type Preference, type Ranked } from './model-planner.ts';
import { resolveSecret } from '../secrets/broker.ts';

// ─── hardware & planning ─────────────────────────────────────────────────────

export type { Hardware } from './hardware.ts';
export const hardware = (force = false) => detectHardware(force);
export const preference = (): Preference => getSetting<Preference>('lmstudio.preference', 'balanced');
export const calibration = (): Calibration => getSetting<Calibration>('lmstudio.calibration', {});

/** Is the server on this machine (so its hardware is ours and `lms` can manage it)? */
export function isLocalUrl(baseUrl: string) {
  try {
    const h = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    if (['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(h)) return true;
    return Object.values(os.networkInterfaces()).flat().some((i) => i?.address === h);
  } catch { return false; }
}

// ─── the lms CLI ─────────────────────────────────────────────────────────────

export function lmsBinary(): string | null {
  const env = process.env.AUDA_LMS_BIN;
  if (env) return fs.existsSync(env) ? env : null;
  const exe = process.platform === 'win32' ? 'lms.exe' : 'lms';
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.lmstudio', 'bin'), path.join(os.homedir(), '.cache', 'lm-studio', 'bin')];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, exe);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

const run = (bin: string, args: string[], timeout: number) => new Promise<{ code: number; out: string }>((resolve) => {
  execFile(bin, args, { timeout, maxBuffer: 4 << 20, env: process.env }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}` });
  });
});

const lms = (args: string[], timeout = 90_000) => {
  const bin = lmsBinary();
  if (!bin) throw new Error('LM Studio’s command-line tool (lms) isn’t on this machine');
  return run(bin, args, timeout);
};

// ─── ranking & suggestions ───────────────────────────────────────────────────

export type { Ranked } from './model-planner.ts';
export const rankModels = (models: LocalModel[], hw: Hardware | null, pref = preference()) => rankInstalled(models, hw, pref, calibration());

/** The model to use for agents: the best runnable tool-capable one. */
export const pickAgentModel = (ranked: Ranked[]) => ranked.filter((r) => r.tools !== 'no' && r.fits !== 'no');

/** Context when the hardware is unknown (a server elsewhere): 32k within the model's limit. */
export const fallbackContext = (max?: number) => Math.max(4096, Math.min(32_768, max ?? 32_768));

export interface Suggestion {
  key: string; name: string; gb: number; why: string; recommended?: boolean; label?: string;
  variant?: string; format?: string; context?: number; tps?: number; turnSeconds?: number; placement?: string; gpuShare?: number; reasons?: string[]; meets?: boolean; quality?: number;
}
const toSuggestion = (o: Option, extra: Partial<Suggestion> = {}): Suggestion => ({
  key: o.key, name: o.name, gb: o.downloadGb, why: o.why, variant: o.variant, format: o.format, context: o.context, tps: o.tps, turnSeconds: o.turnSeconds,
  placement: o.placement, gpuShare: o.gpuShare, reasons: o.reasons, meets: o.meets, quality: o.quality, ...extra,
});
export const EMBEDDING_SUGGESTION: Suggestion = { key: 'nomic-ai/nomic-embed-text-v1.5', name: 'Nomic Embed v1.5', gb: 0.08, why: 'Better knowledge search for agents; tiny.' };

/** Downloads planned for this machine and preference: the best, then a faster / smarter / other choice. */
export function suggest(hw: Hardware | null, pref = preference()): Suggestion[] {
  if (!hw) return [toSuggestion(bestOf(CATALOG.find((c) => c.key === 'qwen/qwen3-8b')!, GENERIC, pref)!, { recommended: true })];
  const plan = planDownloads(hw, pref, calibration());
  if (!plan.best) return [];
  return [toSuggestion(plan.best, { recommended: true }), ...plan.alternatives.map((o) => toSuggestion(o, { label: o === plan.faster ? 'Faster' : o === plan.smarter ? 'Smarter' : undefined }))];
}
/** A mid-range machine, for planning when the server's hardware is unknown. */
const GENERIC = { platform: 'linux', arch: 'x64', cpu: { model: '', vendor: '', arch: 'x64', physicalCores: 8, threads: 16, avx2: true, avx512: false, amx: false, neon: false }, ram: { totalGb: 32, freeGb: 16, bandwidthGBs: 60 }, gpus: [], unified: false, backend: 'cuda', fastGb: 11, maxGb: 30, bandwidth: { fast: 360, ram: 60 }, tier: 'mid', summary: '', notes: [], fingerprint: '' } as Hardware;

// ─── server control ──────────────────────────────────────────────────────────

const keyOf = () => resolveSecret(modelSettings().local?.apiKeySecret);

export async function startServer(baseUrl: string, apiKey = keyOf()) {
  const port = new URL(baseUrl).port || '1234';
  await lms(['daemon', 'up'], 60_000).catch(() => undefined); // llmster (0.4+); the desktop app ignores it
  const r = await lms(['server', 'start', '--port', port], 90_000);
  for (let i = 0; i < 60; i++) {
    try { await listModels(baseUrl, apiKey); return; } catch (e) { if ((e as any).auth) return; }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`LM Studio’s server didn’t come up on port ${port}${r.out ? `: ${r.out.trim().split('\n').slice(-2).join(' ')}` : ''}`);
}

const v1 = async (baseUrl: string, p: string, body?: unknown, timeout = 30_000, apiKey = keyOf()) => {
  const r = await fetch(`${baseUrl.replace(/\/+$/, '')}${p}`, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(timeout),
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j: any = {};
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) throw Object.assign(new Error(typeof j.error === 'string' ? j.error : j.error?.message ?? (text.slice(0, 200) || `HTTP ${r.status}`)), { status: r.status });
  return j;
};

/** Load a model with a context length; tries smaller windows if memory is short. Returns the context it got. */
/**
 * Load a model with a context length and the planner's settings (flash attention, KV cache placement,
 * batch size; GPU share through the CLI). Tries smaller windows if memory is short. Returns the context it got.
 */
export async function loadModel(baseUrl: string, model: string, context: number, apiKey = keyOf(), settings: Partial<LoadSettings> = {}): Promise<{ context: number; seconds?: number; via: 'api' | 'lms' }> {
  const ladder = [...new Set([context, 16_384, 8192].filter((c) => c <= context))];
  const { gpu, context_length: _c, ...apiSettings } = settings;
  let lastErr: unknown;
  for (const ctx of ladder) {
    try {
      const r = await v1(baseUrl, '/api/v1/models/load', { model, ...apiSettings, context_length: ctx, echo_load_config: true }, 15 * 60_000, apiKey);
      return { context: r.load_config?.context_length ?? ctx, seconds: r.load_time_seconds, via: 'api' };
    } catch (e) {
      lastErr = e;
      if ((e as any).status === 404 && !/model/i.test((e as Error).message)) {
        // LM Studio before 0.4 has no load endpoint; the CLI can do it when the server is on this machine.
        if (!isLocalUrl(baseUrl) || !lmsBinary()) throw new Error('This LM Studio can’t be told to load models remotely — update it to 0.4 or newer, or load the model in LM Studio.');
        const r = await lms(['load', model, '--context-length', String(ctx), ...(gpu !== undefined ? ['--gpu', gpu >= 0.98 ? 'max' : gpu <= 0 ? 'off' : String(gpu)] : [])], 15 * 60_000);
        if (r.code === 0) return { context: ctx, via: 'lms' };
        lastErr = new Error(r.out.trim().split('\n').slice(-2).join(' ') || 'lms load failed');
      }
    }
  }
  throw lastErr;
}

export async function unloadModel(baseUrl: string, instanceId: string) {
  await v1(baseUrl, '/api/v1/models/unload', { instance_id: instanceId }).catch(() => undefined);
}

export interface DownloadProgress { model: string; pct: number; downloadedBytes: number; totalBytes: number; bytesPerSecond?: number; eta?: string }

/** Download a model through LM Studio (0.4+), reporting progress. */
export async function downloadModel(baseUrl: string, model: string, onProgress: (p: DownloadProgress) => void, apiKey = keyOf()) {
  let r: any;
  try { r = await v1(baseUrl, '/api/v1/models/download', { model }, 60_000, apiKey); }
  catch (e) {
    if ((e as any).status === 404) throw new Error(`This LM Studio can’t download models for AUDA — update it to 0.4 or newer, or run \`lms get ${model}\`.`);
    throw e;
  }
  if (r.status === 'already_downloaded') { onProgress({ model, pct: 100, downloadedBytes: 0, totalBytes: 0 }); return; }
  const total = r.total_size_bytes ?? 0;
  for (;;) {
    const s = await v1(baseUrl, `/api/v1/models/download/status/${encodeURIComponent(r.job_id)}`, undefined, 30_000, apiKey);
    const done = s.downloaded_bytes ?? (s.status === 'completed' ? total : 0), all = s.total_size_bytes ?? total;
    onProgress({ model, pct: all ? Math.min(100, Math.round((done / all) * 1000) / 10) : 0, downloadedBytes: done, totalBytes: all, bytesPerSecond: s.bytes_per_second, eta: s.estimated_completion });
    if (s.status === 'completed') return;
    if (s.status === 'failed') throw new Error(`The download of ${model} failed`);
    await new Promise((res) => setTimeout(res, Number(process.env.AUDA_LMS_POLL_MS ?? 1000)));
  }
}

/** Download the planned variant (e.g. `qwen/qwen3-14b@q6_k`); if LM Studio doesn't offer it, the catalog's default for this machine. */
export async function downloadPlanned(baseUrl: string, key: string, variant: string | undefined, onProgress: (p: DownloadProgress) => void, apiKey = keyOf()): Promise<string> {
  const isDefault = !variant || /^(Q4_K_M|4bit|MXFP4)$/i.test(variant);
  if (!isDefault) {
    try { await downloadModel(baseUrl, `${key}@${variant!.toLowerCase()}`, onProgress, apiKey); return variant!; }
    catch (e) { if (/update it to 0\.4/.test((e as Error).message)) throw e; log.info(`${key}@${variant} isn’t offered; downloading the default variant`); }
  }
  await downloadModel(baseUrl, key, onProgress, apiKey);
  return 'default';
}

/** Rough generation speed: tokens per second on a short answer. */
export async function measureSpeed(baseUrl: string, model: string, apiKey = keyOf()) {
  const t0 = now();
  const r = await chat({ baseUrl, model, apiKey, tools: false }, { messages: [{ role: 'user', content: 'Write the numbers from 1 to 60, separated by spaces.' }], maxTokens: 160, temperature: 0 });
  const secs = Math.max(0.05, (now() - t0) / 1000);
  return { tps: Math.round((r.usage.output / secs) * 10) / 10, secs: Math.round(secs * 10) / 10 };
}

// ─── setup run (state shown live in the UI) ──────────────────────────────────

export type StepId = 'find' | 'server' | 'model' | 'load' | 'tools' | 'speed' | 'connect';
export interface Step { id: StepId; label: string; state: 'pending' | 'active' | 'done' | 'failed' | 'skipped'; detail?: string }
export interface SetupState {
  running: boolean; auto: boolean; startedAt: number;
  /** Started while AUDA had no model at all (Home shows it as first-run setup). */
  firstRun: boolean; finishedAt?: number; baseUrl?: string;
  steps: Step[]; download?: DownloadProgress;
  outcome?: 'connected' | 'text-only' | 'needs-model' | 'no-server' | 'failed';
  message?: string; suggestions?: Suggestion[]; ranked?: Ranked[]; hardware?: Hardware; preference?: Preference;
  /** A download that would be clearly better than the model in use. */
  upgrade?: Suggestion;
  result?: { model: string; context?: number; tps?: number; predictedTps?: number; placement?: string; gpuShare?: number; variant?: string; tools: boolean; embeddings?: string };
}

const LABELS: Record<StepId, string> = { find: 'Find LM Studio', server: 'Server running', model: 'Choose a model', load: 'Load it with room to think', tools: 'Check it can use tools', speed: 'Measure its speed', connect: 'Connect AUDA' };
let state: SetupState | null = null;
let lastPush = 0, pushTimer: NodeJS.Timeout | null = null;
const push = (force = false) => {
  const fire = () => { pushTimer = null; lastPush = now(); changed('settings', 'settings'); };
  if (force || now() - lastPush > 700) { if (pushTimer) clearTimeout(pushTimer); fire(); }
  else pushTimer ??= setTimeout(fire, 700);
};
export const setupState = () => state;
const step = (id: StepId, s: Step['state'], detail?: string) => {
  if (!state) return;
  state.steps = state.steps.map((x) => x.id === id ? { ...x, state: s, detail: detail ?? x.detail } : x);
  push(s !== 'active');
};

export interface SetupOptions { baseUrl?: string; model?: string; download?: string; apiKey?: string; auto?: boolean; roles?: string[]; preference?: Preference }

let running: Promise<SetupState> | null = null;
/** Run setup (single-flight). Resolves with the final state; progress is pushed as it goes. */
export function runSetup(o: SetupOptions = {}): Promise<SetupState> {
  if (running) return running;
  state = { running: true, auto: !!o.auto, firstRun: !hasReasoningModel(), startedAt: now(), steps: (Object.keys(LABELS) as StepId[]).map((id) => ({ id, label: LABELS[id], state: 'pending' })) };
  push(true);
  running = setup(o).catch((e) => {
    log.warn('LM Studio setup failed', String(e));
    const active = state!.steps.find((s) => s.state === 'active');
    if (active) step(active.id, 'failed', (e as Error).message);
    state!.outcome = 'failed'; state!.message = (e as Error).message;
    return state!;
  }).finally(() => { state!.running = false; state!.finishedAt = now(); running = null; push(true); }) as Promise<SetupState>;
  return running;
}

export interface ConnectArgs { baseUrl: string; model: string; roles: any[]; apiKey?: string; contextLength?: number; probe?: { ok: boolean; tools: boolean; ms: number; sample?: string; error?: string }; extra?: Record<string, unknown> }

async function setup(o: SetupOptions): Promise<SetupState> {
  const s = state!;
  const { probeTools, connect: connectFn, detect: detectFn } = await import('./lmstudio.ts');
  const apiKey = o.apiKey ?? keyOf();
  if (o.preference) setSetting('lmstudio.preference', o.preference);
  const pref = s.preference = preference();
  // 1. Find a server — start one with `lms` if it's installed here.
  step('find', 'active');
  let baseUrl = o.baseUrl?.replace(/\/+$/, '') ?? modelSettings().local?.baseUrl;
  if (!baseUrl) {
    const found = await detectFn();
    baseUrl = (found.find((f) => f.flavor === 'lmstudio') ?? found[0])?.baseUrl;
  }
  if (!baseUrl) {
    if (!lmsBinary()) {
      step('find', 'failed', 'LM Studio isn’t running on this machine or your network.');
      s.outcome = 'no-server'; s.hardware = await hardware(); s.suggestions = suggest(s.hardware, pref);
      s.message = 'Install LM Studio (or its headless server, llmster) and AUDA takes it from there.';
      return s;
    }
    baseUrl = (process.env.LMSTUDIO_URL ?? '').split(',').find((u) => u && isLocalUrl(u))?.replace(/\/+$/, '') ?? 'http://127.0.0.1:1234';
    step('find', 'done', `LM Studio is installed here (${lmsBinary()})`);
  } else step('find', 'done', baseUrl);
  s.baseUrl = baseUrl;

  step('server', 'active');
  let list = await listModels(baseUrl, apiKey).catch((e) => e as Error);
  if (list instanceof Error) {
    if ((list as any).auth) throw list;
    if (!isLocalUrl(baseUrl) || !lmsBinary()) throw new Error(`LM Studio at ${baseUrl} isn’t answering. Start its server (Developer → Start server, or \`lms server start\`)${isLocalUrl(baseUrl) ? '' : ', and turn on “Serve on local network”'}.`);
    step('server', 'active', 'Starting LM Studio’s server…');
    await startServer(baseUrl, apiKey);
    activity('recover', 'Started LM Studio’s server', { detail: `${baseUrl} — so AUDA can run on local models.` });
    list = await listModels(baseUrl, apiKey);
  }
  step('server', 'done', `${baseUrl} · ${list.api === 'v1' ? 'LM Studio 0.4+' : list.api === 'v0' ? 'LM Studio' : 'OpenAI-compatible server'} · ${list.models.length} models`);

  // 2. Choose (and fetch) a model.
  step('model', 'active');
  const hw = isLocalUrl(baseUrl) ? await hardware() : null;
  s.hardware = hw ?? undefined;
  if (o.download) {
    const spec = CATALOG.find((c) => c.key === o.download);
    const planned = spec && hw ? bestOf(spec, hw, pref, calibration()) : null;
    step('model', 'active', `Downloading ${spec?.name ?? o.download}${planned ? ` (${planned.variant})` : ''}…`);
    const got = await downloadPlanned(baseUrl, o.download, planned?.variant, (p) => { s.download = p; push(); }, apiKey);
    s.download = { ...(s.download ?? { model: o.download, downloadedBytes: 0, totalBytes: 0 }), pct: 100 };
    activity('user', `Downloaded ${spec?.name ?? o.download} into LM Studio`, { detail: got === 'default' ? 'LM Studio chose the variant for this machine.' : `${got}, chosen for this machine.` });
    list = await listModels(baseUrl, apiKey);
  }
  const ranked = rankModels(list.models, hw, pref);
  s.ranked = ranked.slice(0, 12);
  const want = o.model ?? (o.download ? list.models.find((m) => m.id === o.download || m.id.endsWith(`/${o.download!.split('/').pop()}`))?.id : undefined);
  const candidates = want ? ranked.filter((r) => r.id === want) : pickAgentModel(ranked);
  if (want && !candidates.length) throw new Error(`${want} isn’t on the server`);
  if (!candidates.length) {
    const textOnly = ranked.filter((r) => r.fits !== 'no');
    step('model', 'failed', textOnly.length ? `${textOnly.length === 1 ? textOnly[0].id + ' doesn’t' : 'None of the ' + textOnly.length + ' models'} call tools, which agents need.` : 'There’s no model on the server yet.');
    s.outcome = 'needs-model'; s.suggestions = suggest(hw, pref);
    const top = s.suggestions[0];
    s.message = top ? `One download and AUDA can work on its own: ${top.name} (${top.gb} GB)${top.tps ? `, about ${Math.round(top.tps)} tokens a second here` : ''}.` : 'This machine is too small for a model that can run agents — connect Claude, or LM Studio on a bigger computer on your network.';
    return s;
  }
  step('model', 'done', `${candidates[0].id} — ${candidates[0].reasons.slice(0, 2).join(', ')}`);

  // 3–5. Load with a proper context, probe tool calling (falling back to the next candidate), measure speed.
  let chosen: Ranked | null = null, context: number | undefined, probe: any;
  for (const c of candidates.slice(0, 3)) {
    step('load', 'active', `${c.id}…`);
    const entry = list.models.find((m) => m.id === c.id)!;
    const settings: Partial<LoadSettings> = c.load ?? { context_length: fallbackContext(c.context) };
    const ctx = settings.context_length ?? fallbackContext(c.context);
    if (list.api === 'v1' || (isLocalUrl(baseUrl) && lmsBinary())) {
      if (entry.state === 'loaded' && (entry.loadedContext ?? 0) >= Math.min(ctx, 16_384)) {
        context = entry.loadedContext; step('load', 'done', `${c.id} is loaded with ${Math.round((context ?? 0) / 1024)}k context`);
      } else {
        if (entry.state === 'loaded' && entry.instances?.length) for (const i of entry.instances) await unloadModel(baseUrl, i);
        const r = await loadModel(baseUrl, c.id, ctx, apiKey, settings);
        context = r.context;
        const where = c.placement === 'gpu' ? (hw?.backend === 'metal' ? 'in unified memory' : 'on the GPU') : c.placement === 'split' ? `${Math.round((c.gpuShare ?? 0) * 100)}% on the GPU` : c.placement === 'cpu' ? 'on the CPU' : '';
        step('load', 'done', `${c.id} · ${Math.round(r.context / 1024)}k context${where ? ` · ${where}` : ''}${settings.flash_attention ? ' · flash attention' : ''}${r.seconds ? ` · ${r.seconds.toFixed(1)} s` : ''}`);
      }
    } else { context = entry.contextLength; step('load', 'skipped', 'This server loads models on first use'); }
    step('tools', 'active', c.id);
    probe = await probeTools(baseUrl, c.id, apiKey);
    if (probe.ok && probe.tools) { chosen = c; step('tools', 'done', `${c.id} called the test tool (${(probe.ms / 1000).toFixed(1)} s)`); break; }
    step('tools', 'failed', probe.ok ? `${c.id} answered but didn’t call the tool` : `${c.id}: ${probe.error}`);
    if (!want && candidates.length > 1) step('load', 'pending');
  }
  const textOnly = !chosen;
  chosen ??= candidates[0];
  if (textOnly && !probe?.ok) throw new Error(`${chosen.id} didn’t answer: ${probe?.error ?? 'no reply'}`);

  step('speed', 'active');
  const speed = await measureSpeed(baseUrl, chosen.id, apiKey).catch(() => null);
  step('speed', speed ? 'done' : 'skipped', speed ? `about ${speed.tps} tokens a second${chosen.tps ? ` (predicted ${Math.round(chosen.tps)})` : ''}` : 'couldn’t measure');
  // Learn how this machine really performs, so the next plan is closer.
  if (speed && hw && chosen.tps && speed.tps > 0) {
    const cal = calibration(), old = cal[hw.backend] ?? 1;
    const measured = speed.tps / (chosen.tps / old);
    setSetting('lmstudio.calibration', { ...cal, [hw.backend]: Math.round(Math.max(0.3, Math.min(3, old * 0.5 + measured * 0.5)) * 100) / 100 });
  }

  // 6. Connect: every role on the chosen model; embeddings if an embedding model is there.
  step('connect', 'active');
  const embed = list.models.find((m) => m.type === 'embeddings')?.id;
  await connectFn({
    baseUrl, model: chosen.id, apiKey: o.apiKey, contextLength: context,
    roles: (o.roles?.length ? o.roles : textOnly ? ['utility'] : ['reasoning', 'utility', 'coding', 'vision']),
    probe, extra: { manage: true, desiredContext: context, api: list.api, tps: speed?.tps, setupAt: now(), loadSettings: chosen.load ? { ...chosen.load, context_length: undefined } : undefined, placement: chosen.placement },
  });
  if (embed && !getSetting('kb.embedModel', '')) setSetting('kb.embedModel', embed);
  if (hw) setSetting('lmstudio.hwFingerprint', hw.fingerprint);
  // A download that would be clearly better here (smarter at the same speed target) — offered, never forced.
  if (hw && !textOnly) {
    const plan = planDownloads(hw, pref, calibration());
    const installed = new Set(list.models.map((m) => m.id));
    if (plan.best && !installed.has(plan.best.key) && plan.best.meets && plan.best.score > (chosen.score ?? 0) + 6) s.upgrade = toSuggestion(plan.best, { recommended: true });
  }
  step('connect', 'done', textOnly ? `${chosen.id} — for text tasks only` : `AUDA now thinks with ${chosen.id}`);
  s.result = { model: chosen.id, context, tps: speed?.tps, predictedTps: chosen.tps, placement: chosen.placement, gpuShare: chosen.gpuShare, variant: chosen.variant, tools: !textOnly, embeddings: embed };
  s.outcome = textOnly ? 'text-only' : 'connected';
  s.suggestions = textOnly ? suggest(hw, pref) : undefined;
  s.message = textOnly
    ? `Connected ${chosen.id} for summaries and chat. For agents, download a tool-calling model${s.suggestions?.[0] ? ` — ${s.suggestions[0].name} suits ${hw ? 'this machine' : 'most machines'}` : ''}.`
    : `Ready: ${chosen.id}${context ? ` with ${Math.round(context / 1024)}k context` : ''}${speed ? `, about ${speed.tps} tokens a second` : ''}. Nothing leaves your network.`;
  return s;
}

// ─── healing ─────────────────────────────────────────────────────────────────

export function classifyLocalError(e: any): 'down' | 'not-loaded' | 'context' | 'other' {
  const msg = String(e?.message ?? e), code = e?.cause?.code ?? e?.code;
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|UND_ERR_SOCKET/.test(String(code)) || /fetch failed|ECONNREFUSED|socket hang up/i.test(msg)) return 'down';
  if (/context (length|window|size|overflow)|n_ctx|exceeds? the (context|maximum)|too many tokens|tokens to keep|prompt is too long|context.*exceed/i.test(msg)) return 'context';
  if (/not loaded|no models? (are )?loaded|model.*not found|model_not_found|failed to load model|unknown model/i.test(msg)) return 'not-loaded';
  return 'other';
}

let healing: Promise<void> | null = null;
let lastRestart = 0;
/** Seen by the health loop: whether the configured model is loaded right now. */
export const liveState: { loaded?: boolean; context?: number; at?: number } = {};

const saveLocal = (patch: Record<string, unknown>) => {
  const cur = getSetting<any>('models', {});
  if (!cur.local) return;
  setSetting('models', { ...cur, local: { ...cur.local, ...patch } });
  changed('settings', 'settings');
};

async function heal(kind: 'down' | 'not-loaded' | 'context' | 'preload', model: string) {
  const l = modelSettings().local as any;
  if (!l?.baseUrl) return;
  if (kind === 'down') {
    if (!isLocalUrl(l.baseUrl) || !lmsBinary() || now() - lastRestart < 60_000) throw new Error('LM Studio isn’t answering');
    lastRestart = now();
    await startServer(l.baseUrl);
    // A restarted server has nothing in memory; load the model as it was, so the retry doesn't hit a cold start.
    const loaded = l.api === 'v1' ? await loadModel(l.baseUrl, model, l.desiredContext ?? l.contextLength ?? 32_768, keyOf(), l.loadSettings ?? {}).catch(() => null) : null;
    if (loaded) { liveState.loaded = true; liveState.context = loaded.context; }
    activity('recover', 'Restarted LM Studio’s server', { detail: `It had stopped answering at ${l.baseUrl}; AUDA started it again${loaded ? `, loaded ${model} (${Math.round(loaded.context / 1024)}k context)` : ''} and carried on.` });
    return;
  }
  const max = (await listModels(l.baseUrl, keyOf()).catch(() => null))?.models.find((m) => m.id === model)?.contextLength ?? 131_072;
  const cur = liveState.context ?? l.contextLength ?? 8192;
  const ctx = kind === 'context' ? Math.min(max, Math.max(cur * 2, 16_384), 131_072) : (l.desiredContext ?? Math.min(l.contextLength ?? 32_768, 32_768));
  if (kind === 'context' && ctx <= cur) throw new Error(`${model} is already at its largest context (${Math.round(cur / 1024)}k)`);
  const r = await loadModel(l.baseUrl, model, ctx, keyOf(), l.loadSettings ?? {});
  liveState.loaded = true; liveState.context = r.context;
  saveLocal({ contextLength: r.context, ...(kind === 'context' ? { desiredContext: r.context } : {}) });
  activity('recover', kind === 'context' ? `Gave ${model} a larger context` : `Loaded ${model}`, { detail: kind === 'context' ? `The conversation outgrew its window; AUDA reloaded it with ${Math.round(r.context / 1024)}k context and retried.` : `It wasn’t in memory (LM Studio unloads idle models); AUDA loaded it with ${Math.round(r.context / 1024)}k context.` });
}

const once = (kind: Parameters<typeof heal>[0], model: string) => {
  healing ??= heal(kind, model).finally(() => { healing = null; });
  return healing;
};

/** Run a local-model call; on a stopped server, an evicted model or a context overflow, fix it once and retry. */
export async function withHealing<T>(model: string, fn: () => Promise<T>): Promise<T> {
  const l = modelSettings().local as any;
  const managed = l?.manage !== false && getSetting('lmstudio.heal', true);
  if (managed && liveState.loaded === false && l?.api === 'v1' && model === l.model) {
    await once('preload', model).catch((e) => log.warn('preload failed', String(e)));
  }
  try { return await fn(); }
  catch (e) {
    if (!managed) throw e;
    const kind = classifyLocalError(e);
    if (kind === 'other') throw e;
    try { await once(kind, model); }
    catch (h) { log.warn(`couldn’t heal LM Studio (${kind})`, String(h)); throw e; }
    return await fn();
  }
}
