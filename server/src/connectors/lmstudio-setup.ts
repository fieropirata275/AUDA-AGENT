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
import { resolveSecret } from '../secrets/broker.ts';

// ─── hardware ────────────────────────────────────────────────────────────────

export interface Hardware {
  platform: string; arch: string; cpu: string; cores: number;
  totalGb: number; freeGb: number;
  gpus: { name: string; vramGb: number }[];
  unified: boolean;
  /** Memory a model can use and still run fast (GPU / unified memory). */
  fastGb: number;
  /** Memory a model can use at all (partly on the CPU — slower). */
  maxGb: number;
  summary: string;
}

const gb = (b: number) => Math.round((b / 1e9) * 10) / 10;
const run = (bin: string, args: string[], timeout: number) => new Promise<{ code: number; out: string }>((resolve) => {
  execFile(bin, args, { timeout, maxBuffer: 4 << 20, env: process.env }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}` });
  });
});

let hwCache: { at: number; hw: Hardware } | null = null;
export async function hardware(): Promise<Hardware> {
  if (hwCache && now() - hwCache.at < 10 * 60_000) return hwCache.hw;
  const totalGb = gb(os.totalmem()), freeGb = gb(os.freemem());
  const gpus: Hardware['gpus'] = [];
  if (process.env.AUDA_FAKE_GPU) {
    const [name, vram] = process.env.AUDA_FAKE_GPU.split(':');
    gpus.push({ name, vramGb: Number(vram) });
  } else {
    const r = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 3000);
    if (r.code === 0) for (const line of r.out.trim().split('\n')) {
      const [name, mib] = line.split(',').map((s) => s.trim());
      if (name && Number(mib)) gpus.push({ name, vramGb: Math.round((Number(mib) / 1024) * 10) / 10 });
    }
  }
  const unified = process.platform === 'darwin' && process.arch === 'arm64';
  const vram = gpus.reduce((s, g) => s + g.vramGb, 0);
  const fastGb = unified ? totalGb * 0.7 : vram ? vram * 0.92 : Math.min(totalGb * 0.4, 12);
  const maxGb = unified ? totalGb * 0.7 : vram ? vram + totalGb * 0.5 : totalGb * 0.6;
  const cpu = os.cpus()[0]?.model?.replace(/\s+/g, ' ').trim() ?? os.arch();
  const summary = unified ? `${totalGb} GB unified memory (Apple silicon)`
    : vram ? `${gpus.map((g) => `${g.name} ${g.vramGb} GB`).join(' + ')} · ${totalGb} GB RAM`
    : `${totalGb} GB RAM, no GPU found (models run on the CPU)`;
  const hw = { platform: process.platform, arch: process.arch, cpu, cores: os.cpus().length, totalGb, freeGb, gpus, unified, fastGb: Math.round(fastGb * 10) / 10, maxGb: Math.round(maxGb * 10) / 10, summary };
  hwCache = { at: now(), hw };
  return hw;
}

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

const lms = (args: string[], timeout = 90_000) => {
  const bin = lmsBinary();
  if (!bin) throw new Error('LM Studio’s command-line tool (lms) isn’t on this machine');
  return run(bin, args, timeout);
};

// ─── ranking ─────────────────────────────────────────────────────────────────

/** Families that reliably call tools when LM Studio doesn't say. */
const TOOL_FAMILIES = /qwen3|qwen2\.5|gpt-oss|llama-?3\.[1-3]|llama-?4|mistral-(small|nemo|large|medium)|devstral|magistral|ministral|gemma-?[34]|granite-?[34]|glm-?4|hermes|command-r|phi-?4|deepseek-(v3|r1)|kimi|nemotron|functionary|xlam/i;

export function paramsB(m: Pick<LocalModel, 'id' | 'params'>): { total?: number; active?: number } {
  const src = `${m.params ?? ''} ${m.id}`.toLowerCase();
  const total = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/.exec(src)?.[1];
  const active = /a(\d+(?:\.\d+)?)b(?![a-z])/.exec(src)?.[1];
  return { total: total ? Number(total) : undefined, active: active ? Number(active) : undefined };
}

/** Memory a model needs in GB — its file size when LM Studio says, else estimated from parameters and quantization. */
export function estimateGb(m: LocalModel): number | undefined {
  if (m.sizeBytes) return gb(m.sizeBytes * 1.1);
  const { total } = paramsB(m);
  if (!total) return undefined;
  const q = (m.quantization ?? '').toUpperCase();
  const bits = /F16|BF16/.test(q) ? 16 : /Q8|8BIT/.test(q) ? 8.5 : /Q6/.test(q) ? 6.6 : /Q5/.test(q) ? 5.5 : /Q3/.test(q) ? 3.5 : /Q2/.test(q) ? 2.7 : 4.8;
  return Math.round(total * bits / 8 * 1.1 * 10) / 10;
}

export interface Ranked {
  id: string; score: number; tools: 'yes' | 'likely' | 'no'; fits: 'fast' | 'slow' | 'no' | 'unknown';
  gb?: number; context?: number; loaded: boolean; reasons: string[]; vision?: boolean;
}

export function rankModels(models: LocalModel[], hw: Hardware | null): Ranked[] {
  const out: Ranked[] = [];
  for (const m of models) {
    if (m.type === 'embeddings' || /embed/i.test(m.id)) continue;
    const reasons: string[] = [];
    let score = 0;
    // LM Studio's flag when it gives one; else the family. The tool-calling probe has the final word.
    const tools: Ranked['tools'] = m.tools === true ? 'yes' : TOOL_FAMILIES.test(m.id) ? 'likely' : 'no';
    if (tools === 'yes') { score += 40; reasons.push('trained for tool use'); }
    else if (tools === 'likely') { score += 30; reasons.push('a family that calls tools'); }
    else reasons.push('not known to call tools — text tasks only');
    const need = estimateGb(m);
    const { total, active } = paramsB(m);
    let fits: Ranked['fits'] = 'unknown';
    if (hw && need) {
      if (need <= hw.fastGb) { fits = 'fast'; reasons.push(`fits in ${hw.unified ? 'memory' : hw.gpus.length ? 'GPU memory' : 'memory'} (${need} GB)`); }
      else if (need <= hw.maxGb) { fits = 'slow'; score -= 15; reasons.push(`${need} GB — partly on the CPU, slower`); }
      else if (m.state === 'loaded') { fits = 'slow'; score -= 10; reasons.push(`${need} GB — larger than expected, but it’s loaded and running`); }
      else { fits = 'no'; score -= 100; reasons.push(`needs about ${need} GB — more than this machine has`); }
    }
    if (total) score += Math.min(total, 40) * (fits === 'slow' ? 0.4 : 1.1);
    if (active && total && active < total) { score += 4; reasons.push(`mixture of experts (${active}B active) — quick`); }
    const ctx = m.contextLength;
    if (ctx) {
      if (ctx >= 32_768) score += 8;
      else if (ctx < 8192) { score -= 40; reasons.push(`only ${Math.round(ctx / 1024)}k context`); }
      else if (ctx < 16_384) score -= 15;
    }
    if (m.state === 'loaded') { score += 6; reasons.push('already loaded'); }
    if (/coder|devstral/i.test(m.id)) score += 2;
    out.push({ id: m.id, score: Math.round(score * 10) / 10, tools, fits, gb: need, context: ctx, loaded: m.state === 'loaded', reasons, vision: m.vision });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The model to use for agents: the best runnable tool-capable one. */
export const pickAgentModel = (ranked: Ranked[]) => ranked.filter((r) => r.tools !== 'no' && r.fits !== 'no');

/** Context to load with: room for an agent's working set, within the model's limit and the memory left over. */
export function pickContext(model: Pick<Ranked, 'context' | 'gb'>, hw: Hardware | null): number {
  const max = model.context ?? 32_768;
  let want = 32_768;
  if (hw && model.gb) {
    const headroom = hw.fastGb - model.gb;
    if (headroom < 2) want = 8192;
    else if (headroom < 4) want = 16_384;
    else if (headroom > 16 && max >= 65_536) want = 65_536;
  }
  return Math.max(4096, Math.min(want, max));
}

export interface Suggestion { key: string; name: string; gb: number; why: string; recommended?: boolean }
const CATALOG: (Suggestion & { minGb: number })[] = [
  { key: 'qwen/qwen3-4b-2507', name: 'Qwen3 4B', gb: 2.5, minGb: 5, why: 'Small and quick, and calls tools reliably for its size.' },
  { key: 'qwen/qwen3-8b', name: 'Qwen3 8B', gb: 5, minGb: 9, why: 'A good all-rounder for agents on a laptop or a mid-range GPU.' },
  { key: 'openai/gpt-oss-20b', name: 'gpt-oss 20B', gb: 12.1, minGb: 15, why: 'Strong reasoning and tool use, and fast (mixture of experts).' },
  { key: 'google/gemma-4-26b-a4b', name: 'Gemma 4 26B A4B', gb: 17, minGb: 22, why: 'Capable and fast (4B active), with vision.' },
  { key: 'openai/gpt-oss-120b', name: 'gpt-oss 120B', gb: 65, minGb: 75, why: 'The strongest open model for agents, for big-memory machines.' },
];
export const EMBEDDING_SUGGESTION: Suggestion = { key: 'nomic-ai/nomic-embed-text-v1.5', name: 'Nomic Embed v1.5', gb: 0.08, why: 'Better knowledge search for agents; tiny.' };

/** Downloads sized for this machine: the largest that runs fast, plus a lighter alternative. */
export function suggest(hw: Hardware | null): Suggestion[] {
  const budget = hw ? (hw.gpus.length || hw.unified ? hw.fastGb : Math.min(hw.maxGb, 12)) : 9;
  const fit = CATALOG.filter((c) => c.minGb <= Math.max(budget, 5));
  const best = fit[fit.length - 1] ?? CATALOG[0];
  const lighter = fit.length > 1 ? fit[fit.length - 2] : undefined;
  return [{ ...best, recommended: true }, ...(lighter ? [lighter] : [])].map(({ minGb: _m, ...s }: any) => s);
}

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
export async function loadModel(baseUrl: string, model: string, context: number, apiKey = keyOf()): Promise<{ context: number; seconds?: number; via: 'api' | 'lms' }> {
  const ladder = [...new Set([context, 16_384, 8192].filter((c) => c <= context))];
  let lastErr: unknown;
  for (const ctx of ladder) {
    try {
      const r = await v1(baseUrl, '/api/v1/models/load', { model, context_length: ctx, echo_load_config: true }, 15 * 60_000, apiKey);
      return { context: r.load_config?.context_length ?? ctx, seconds: r.load_time_seconds, via: 'api' };
    } catch (e) {
      lastErr = e;
      if ((e as any).status === 404 && !/model/i.test((e as Error).message)) {
        // LM Studio before 0.4 has no load endpoint; the CLI can do it when the server is on this machine.
        if (!isLocalUrl(baseUrl) || !lmsBinary()) throw new Error('This LM Studio can’t be told to load models remotely — update it to 0.4 or newer, or load the model in LM Studio.');
        const r = await lms(['load', model, '--context-length', String(ctx)], 15 * 60_000);
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
  message?: string; suggestions?: Suggestion[]; ranked?: Ranked[]; hardware?: Hardware;
  result?: { model: string; context?: number; tps?: number; tools: boolean; embeddings?: string };
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

export interface SetupOptions { baseUrl?: string; model?: string; download?: string; apiKey?: string; auto?: boolean; roles?: string[] }

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
      s.outcome = 'no-server'; s.hardware = await hardware(); s.suggestions = suggest(s.hardware);
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
    step('model', 'active', `Downloading ${o.download}…`);
    await downloadModel(baseUrl, o.download, (p) => { s.download = p; push(); }, apiKey);
    s.download = { ...(s.download ?? { model: o.download, downloadedBytes: 0, totalBytes: 0 }), pct: 100 };
    activity('user', `Downloaded ${o.download} into LM Studio`);
    list = await listModels(baseUrl, apiKey);
  }
  const ranked = rankModels(list.models, hw);
  s.ranked = ranked.slice(0, 12);
  const want = o.model ?? (o.download ? list.models.find((m) => m.id === o.download || m.id.endsWith(`/${o.download!.split('/').pop()}`))?.id : undefined);
  const candidates = want ? ranked.filter((r) => r.id === want) : pickAgentModel(ranked);
  if (want && !candidates.length) throw new Error(`${want} isn’t on the server`);
  if (!candidates.length) {
    const textOnly = ranked.filter((r) => r.fits !== 'no');
    step('model', 'failed', textOnly.length ? `${textOnly.length === 1 ? textOnly[0].id + ' doesn’t' : 'None of the ' + textOnly.length + ' models'} call tools, which agents need.` : 'There’s no model on the server yet.');
    s.outcome = 'needs-model'; s.suggestions = suggest(hw);
    s.message = `One download and AUDA can work on its own: ${s.suggestions[0].name} (${s.suggestions[0].gb} GB) suits ${hw ? 'this machine' : 'most machines'}.`;
    return s;
  }
  step('model', 'done', `${candidates[0].id} — ${candidates[0].reasons.slice(0, 2).join(', ')}`);

  // 3–5. Load with a proper context, probe tool calling (falling back to the next candidate), measure speed.
  let chosen: Ranked | null = null, context: number | undefined, probe: any;
  for (const c of candidates.slice(0, 3)) {
    step('load', 'active', `${c.id}…`);
    const entry = list.models.find((m) => m.id === c.id)!;
    const ctx = pickContext(c, hw);
    if (list.api === 'v1' || (isLocalUrl(baseUrl) && lmsBinary())) {
      if (entry.state === 'loaded' && (entry.loadedContext ?? 0) >= Math.min(ctx, 16_384)) {
        context = entry.loadedContext; step('load', 'done', `${c.id} is loaded with ${Math.round((context ?? 0) / 1024)}k context`);
      } else {
        if (entry.state === 'loaded' && entry.instances?.length) for (const i of entry.instances) await unloadModel(baseUrl, i);
        const r = await loadModel(baseUrl, c.id, ctx, apiKey);
        context = r.context;
        step('load', 'done', `${c.id} · ${Math.round(r.context / 1024)}k context${r.seconds ? ` · loaded in ${r.seconds.toFixed(1)} s` : ''}`);
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
  step('speed', speed ? 'done' : 'skipped', speed ? `about ${speed.tps} tokens a second` : 'couldn’t measure');

  // 6. Connect: every role on the chosen model; embeddings if an embedding model is there.
  step('connect', 'active');
  const embed = list.models.find((m) => m.type === 'embeddings')?.id;
  await connectFn({
    baseUrl, model: chosen.id, apiKey: o.apiKey, contextLength: context,
    roles: (o.roles?.length ? o.roles : textOnly ? ['utility'] : ['reasoning', 'utility', 'coding', 'vision']),
    probe, extra: { manage: true, desiredContext: context, api: list.api, tps: speed?.tps, setupAt: now() },
  });
  if (embed && !getSetting('kb.embedModel', '')) setSetting('kb.embedModel', embed);
  step('connect', 'done', textOnly ? `${chosen.id} — for text tasks only` : `AUDA now thinks with ${chosen.id}`);
  s.result = { model: chosen.id, context, tps: speed?.tps, tools: !textOnly, embeddings: embed };
  s.outcome = textOnly ? 'text-only' : 'connected';
  s.suggestions = textOnly ? suggest(hw) : undefined;
  s.message = textOnly
    ? `Connected ${chosen.id} for summaries and chat. For agents, download a tool-calling model — ${suggest(hw)[0].name} suits ${hw ? 'this machine' : 'most machines'}.`
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
    const loaded = l.api === 'v1' ? await loadModel(l.baseUrl, model, l.desiredContext ?? l.contextLength ?? 32_768).catch(() => null) : null;
    if (loaded) { liveState.loaded = true; liveState.context = loaded.context; }
    activity('recover', 'Restarted LM Studio’s server', { detail: `It had stopped answering at ${l.baseUrl}; AUDA started it again${loaded ? `, loaded ${model} (${Math.round(loaded.context / 1024)}k context)` : ''} and carried on.` });
    return;
  }
  const max = (await listModels(l.baseUrl, keyOf()).catch(() => null))?.models.find((m) => m.id === model)?.contextLength ?? 131_072;
  const cur = liveState.context ?? l.contextLength ?? 8192;
  const ctx = kind === 'context' ? Math.min(max, Math.max(cur * 2, 16_384), 131_072) : (l.desiredContext ?? Math.min(l.contextLength ?? 32_768, 32_768));
  if (kind === 'context' && ctx <= cur) throw new Error(`${model} is already at its largest context (${Math.round(cur / 1024)}k)`);
  const r = await loadModel(l.baseUrl, model, ctx);
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
