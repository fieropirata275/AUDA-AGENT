/**
 * Model Router. AUDA is one entity; models are interchangeable organs.
 * Roles: reasoning · utility · vision · coding · fallback. Each role maps to a
 * provider+model. Budgets are enforced here, before any call leaves the box.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getSetting, insert, now, q, uid } from '../core/db.ts';
import { resolveSecret } from '../secrets/broker.ts';
import { log } from '../core/log.ts';
import { chat as oaiChat } from './openai.ts';
import { guarded } from '../connectors/runtime.ts';
import { withHealing } from '../connectors/lmstudio-setup.ts';

export type Role = 'reasoning' | 'utility' | 'vision' | 'coding' | 'fallback';
export interface RoleTarget { provider: 'anthropic' | 'local' | 'none'; model: string }
export interface ModelSettings {
  roles: Record<Role, RoleTarget>;
  anthropicSecret?: string;
  /** OpenAI-compatible local server (LM Studio, Ollama, llama.cpp, vLLM). */
  local?: {
    baseUrl: string; model: string; kind?: 'lmstudio' | 'openai'; tools?: boolean; apiKeySecret?: string; contextLength?: number;
    /** AUDA may start the server, load the model and heal failures (set by one-click setup). */
    manage?: boolean; desiredContext?: number; api?: 'v1' | 'v0' | 'openai'; tps?: number; setupAt?: number;
    /** The planner's load settings for this machine (flash attention, KV placement, batch, GPU share). */
    loadSettings?: Record<string, unknown>; placement?: string;
  };
  dailyBudget?: number;      // in currency units (€/$), 0 = unlimited
  monthlyBudget?: number;
}

export const DEFAULT_MODELS: ModelSettings = {
  roles: {
    reasoning: { provider: 'anthropic', model: 'claude-opus-5-5' },
    coding: { provider: 'anthropic', model: 'claude-opus-5-5' },
    vision: { provider: 'anthropic', model: 'claude-opus-5-5' },
    utility: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    fallback: { provider: 'local', model: '' },
  },
  dailyBudget: 2,
  monthlyBudget: 30,
};

// USD per million tokens [input, output].
const PRICES: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50], 'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10], 'claude-haiku-4-5': [1, 5],
};

export const modelSettings = (): ModelSettings => {
  const s = getSetting<Partial<ModelSettings>>('models', {});
  return { ...DEFAULT_MODELS, ...s, roles: { ...DEFAULT_MODELS.roles, ...(s.roles ?? {}) } };
};

function anthropicKey() {
  return resolveSecret(modelSettings().anthropicSecret) ?? process.env.ANTHROPIC_API_KEY;
}

let client: Anthropic | null = null;
let clientKey: string | undefined;
function anthropic() {
  const key = anthropicKey();
  if (!key) return null;
  if (!client || clientKey !== key) { client = new Anthropic({ apiKey: key, maxRetries: 2 }); clientKey = key; }
  return client;
}

/**
 * Test/dev provider: AUDA_MOCK_MODEL points at a module exporting
 * `respond(args) => { content, stopReason }`. Lets the agent path (tools,
 * subtasks, verification, loops, crashes) be exercised without an API key.
 */
const MOCK = process.env.AUDA_MOCK_MODEL;
let mockMod: any = null;
async function callMock(a: CompleteArgs): Promise<CompleteResult> {
  mockMod ??= await import(MOCK!);
  const r = await mockMod.respond(a);
  const content = r.content ?? [{ type: 'text', text: r.text ?? '' }];
  record(a, { provider: 'local', model: 'mock' }, 0, 0, true);
  return {
    text: content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'), content,
    toolUses: content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, input: b.input })),
    stopReason: r.stopReason ?? (content.some((b: any) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'), model: 'mock',
  };
}

export function providerReady(t: RoleTarget) {
  if (MOCK) return true;
  if (t.provider === 'anthropic') return Boolean(anthropicKey());
  if (t.provider === 'local') return Boolean(modelSettings().local?.baseUrl && (t.model || modelSettings().local?.model));
  return false;
}
export const hasReasoningModel = () => providerReady(modelSettings().roles.reasoning);
export const canUseTools = () => {
  if (MOCK) return true;
  const s = modelSettings(), r = s.roles.reasoning;
  if (!providerReady(r)) return false;
  return r.provider === 'anthropic' || (r.provider === 'local' && s.local?.tools !== false);
};
/** Rough context budget (characters) for the reasoning model, used to decide when agents hand off. */
export const contextChars = () => {
  const s = modelSettings();
  if (s.roles.reasoning.provider === 'local' && s.local?.contextLength) return Math.floor(s.local.contextLength * 2.6);
  return Infinity;
};
export const supportsServerTools = () => !MOCK && modelSettings().roles.reasoning.provider === 'anthropic';

export class BudgetExceeded extends Error {}

export function spend() {
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const month = new Date(day); month.setDate(1);
  const sum = (since: number) => (q.get('SELECT COALESCE(SUM(cost_micro),0) s FROM model_calls WHERE ts >= ?', since)?.s ?? 0) / 1e6;
  return { today: sum(day.getTime()), month: sum(month.getTime()) };
}

function checkBudget() {
  const s = modelSettings(), sp = spend();
  if (s.dailyBudget && sp.today >= s.dailyBudget) throw new BudgetExceeded(`Daily model budget of ${s.dailyBudget} reached`);
  if (s.monthlyBudget && sp.month >= s.monthlyBudget) throw new BudgetExceeded(`Monthly model budget of ${s.monthlyBudget} reached`);
}

let inFlight = 0;
const flightListeners: ((n: number) => void)[] = [];
export const onThinking = (fn: (n: number) => void) => flightListeners.push(fn);
const setFlight = (d: number) => { inFlight += d; flightListeners.forEach((f) => f(inFlight)); };

export interface CompleteArgs {
  role: Role;
  purpose: string;
  system?: string;
  prompt?: string;
  messages?: Anthropic.Beta.BetaMessageParam[];
  tools?: Anthropic.Beta.BetaToolUnion[];
  signal?: AbortSignal;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  taskId?: string;
}
export interface CompleteResult {
  text: string;
  content: Anthropic.Beta.BetaContentBlock[];
  toolUses: { id: string; name: string; input: any }[];
  stopReason: string | null;
  model: string;
}

export async function complete(a: CompleteArgs): Promise<CompleteResult> {
  checkBudget();
  const s = modelSettings();
  const targets = [s.roles[a.role], s.roles.fallback].filter((t) => t && providerReady(t));
  if (!targets.length) throw new Error('No model is connected for this. Connect one in Settings → Models.');
  let lastErr: unknown;
  for (const t of targets) {
    setFlight(1);
    try {
      if (MOCK) return await callMock(a);
      return t.provider === 'anthropic' ? await callAnthropic(t.model, a) : await callLocal(t.model || s.local!.model, a);
    } catch (e) {
      lastErr = e;
      if (a.signal?.aborted) throw e;
      log.warn(`model ${t.provider}/${t.model} failed for ${a.purpose}`, String(e));
      record(a, t, 0, 0, false);
    } finally { setFlight(-1); }
  }
  throw lastErr;
}

async function callAnthropic(model: string, a: CompleteArgs): Promise<CompleteResult> {
  const c = anthropic();
  if (!c) throw new Error('Anthropic is not connected');
  const serverFallback = /^claude-(opus-5|opus-5-5|sonnet-5-5|fable-5-1)$/.test(model);
  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: a.maxTokens ?? 16000,
    system: a.system,
    messages: a.messages ?? [{ role: 'user', content: a.prompt ?? '' }],
    ...(a.tools?.length ? { tools: a.tools } : {}),
    ...(model !== 'claude-haiku-4-5' ? { thinking: { type: 'adaptive' as const }, output_config: { effort: a.effort ?? 'medium' } } : {}),
    ...(serverFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as any } : {}),
  };
  const res = await c.beta.messages.create(params, { signal: a.signal, timeout: 10 * 60_000 });
  record(a, { provider: 'anthropic', model }, res.usage.input_tokens, res.usage.output_tokens, true);
  if (res.stop_reason === 'refusal') throw new Error('The model declined this request.');
  const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n');
  const toolUses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
  return { text, content: res.content, toolUses, stopReason: res.stop_reason, model: res.model };
}

/** OpenAI-compatible local endpoint (LM Studio, Ollama, llama.cpp, vLLM…) — with tool calling. */
async function callLocal(model: string, a: CompleteArgs): Promise<CompleteResult> {
  const l = modelSettings().local;
  if (!l?.baseUrl) throw new Error('No local model endpoint configured');
  const r = await guarded('lmstudio', () => withHealing(model, () => oaiChat(
    { baseUrl: l.baseUrl, model, apiKey: resolveSecret(l.apiKeySecret), tools: l.tools },
    { system: a.system, messages: (a.messages ?? [{ role: 'user', content: a.prompt ?? '' }]) as any, tools: a.tools as any[], maxTokens: Math.min(a.maxTokens ?? 4096, 16_384), signal: a.signal },
  )));
  record(a, { provider: 'local', model }, r.usage.input, r.usage.output, true);
  const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return { text, content: r.content as any, toolUses: r.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input })), stopReason: r.stopReason, model: r.model };
}

function record(a: CompleteArgs, t: RoleTarget, inTok: number, outTok: number, ok: boolean) {
  const p = PRICES[t.model] ?? [0, 0];
  const cost = Math.round((inTok * p[0] + outTok * p[1]));  // micro-units: tokens × $/M
  insert('model_calls', { id: uid('mc'), ts: now(), role: a.role, provider: t.provider, model: t.model, input_tokens: inTok, output_tokens: outTok, cost_micro: cost, task_id: a.taskId, purpose: a.purpose, ok: ok ? 1 : 0 });
  if (a.taskId && cost) q.run('UPDATE tasks SET cost_micro = cost_micro + ? WHERE id = ?', cost, a.taskId);
}
