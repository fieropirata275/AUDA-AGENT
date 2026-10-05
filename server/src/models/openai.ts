/**
 * OpenAI-compatible chat completions with tool calling — the protocol spoken
 * by LM Studio's headless server (`lms server start`), Ollama, llama.cpp,
 * vLLM and others. AUDA's agents think in Anthropic-style content blocks; this
 * module translates both ways so the same agent loop runs on a local model.
 *
 * Local models are less predictable than hosted ones, so parsing is lenient:
 * malformed tool arguments are repaired where possible, and tool calls a model
 * writes into plain text (<tool_call>{…}</tool_call>, ```json fences) are
 * recovered instead of being lost.
 */
export interface OAIConfig { baseUrl: string; model: string; apiKey?: string; tools?: boolean }

type Block = { type: string; [k: string]: any };
type Msg = { role: 'user' | 'assistant'; content: string | Block[] };

/** Anthropic-style messages → OpenAI chat messages. */
export function toOpenAIMessages(system: string | undefined, messages: Msg[]) {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      // Tool results become `tool` messages (in order); remaining text becomes a user message.
      for (const b of m.content) if (b.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => x.text ?? '').join('\n') : String(b.content ?? '');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${content}` : content });
      }
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

/** Anthropic tool definitions → OpenAI function tools (server tools are dropped). */
export function toOpenAITools(tools: any[] = []) {
  return tools.filter((t) => t.input_schema).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

/** Best-effort JSON parse for model-written arguments. */
export function lenientJson(s: string): any {
  if (!s || !s.trim()) return {};
  const attempts = [
    s,
    s.replace(/^```(?:json)?\s*|\s*```$/g, ''),
    s.replace(/,\s*([}\]])/g, '$1'),
    s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1),
  ];
  for (const a of attempts) { try { const v = JSON.parse(a); if (v && typeof v === 'object') return v; } catch { /* next */ } }
  throw new Error(`Could not parse tool arguments: ${s.slice(0, 200)}`);
}

let synth = 0;
const toolId = () => `call_${Date.now().toString(36)}_${(synth++).toString(36)}`;

/** Recover tool calls a model wrote into its text instead of the tool_calls field. */
export function extractTextToolCalls(text: string, known: Set<string>): { calls: { id: string; name: string; input: any }[]; rest: string } {
  const calls: { id: string; name: string; input: any }[] = [];
  let rest = text;
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>|```(?:json)?\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*```/g;
  for (const m of text.matchAll(re)) {
    try {
      const j = lenientJson(m[1] ?? m[2]);
      const name = j.name ?? j.function?.name, args = j.arguments ?? j.parameters ?? j.function?.arguments ?? {};
      if (name && known.has(name)) { calls.push({ id: toolId(), name, input: typeof args === 'string' ? lenientJson(args) : args }); rest = rest.replace(m[0], ''); }
    } catch { /* not a tool call */ }
  }
  return { calls, rest: rest.trim() };
}

export interface OAIResult { content: Block[]; stopReason: string; usage: { input: number; output: number }; model: string }

export async function chat(cfg: OAIConfig, a: { system?: string; messages: Msg[]; tools?: any[]; maxTokens?: number; signal?: AbortSignal; temperature?: number }): Promise<OAIResult> {
  const tools = cfg.tools === false ? [] : toOpenAITools(a.tools);
  const body: any = {
    model: cfg.model, messages: toOpenAIMessages(a.system, a.messages), max_tokens: a.maxTokens ?? 4096, stream: false,
    temperature: a.temperature ?? 0.3,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
  };
  const timeout = AbortSignal.timeout(15 * 60_000); // local models can be slow, but never unbounded
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify(body), signal: a.signal ? AbortSignal.any([a.signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err: any = new Error(`Local model HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const j: any = await res.json();
  const choice = j.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const known = new Set((a.tools ?? []).map((t: any) => t.name));
  const content: Block[] = [];
  let text = typeof msg.content === 'string' ? msg.content : '';
  // Some local models put their reasoning in <think> tags; it is not shown as the answer.
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const calls: { id: string; name: string; input: any }[] = [];
  for (const c of msg.tool_calls ?? []) {
    const name = c.function?.name;
    let input: any;
    try { input = typeof c.function?.arguments === 'string' ? lenientJson(c.function.arguments) : c.function?.arguments ?? {}; }
    catch (e) { input = { __invalid: String((e as Error).message) }; }
    if (name) calls.push({ id: c.id || toolId(), name, input });
  }
  if (!calls.length && known.size && text) {
    const rec = extractTextToolCalls(text, known);
    calls.push(...rec.calls);
    if (rec.calls.length) text = rec.rest;
  }
  if (text) content.push({ type: 'text', text });
  for (const c of calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
  const stopReason = calls.length ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  return { content, stopReason, usage: { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 }, model: j.model ?? cfg.model };
}

export interface LocalModel {
  id: string; type: 'llm' | 'embeddings' | string; state: 'loaded' | 'not-loaded' | 'unknown' | string;
  contextLength?: number; loadedContext?: number; instances?: string[]; sizeBytes?: number; params?: string;
  tools?: boolean; vision?: boolean; quantization?: string; arch?: string; publisher?: string; displayName?: string;
}

/**
 * List models. Prefers LM Studio's v1 REST API (0.4+: size, capabilities, loaded
 * instances and their context), then v0 (load state, context length), then the
 * OpenAI-compatible /v1/models any server has.
 */
export async function listModels(baseUrl: string, apiKey?: string): Promise<{ flavor: 'lmstudio' | 'openai'; api: 'v1' | 'v0' | 'openai'; models: LocalModel[] }> {
  const base = baseUrl.replace(/\/+$/, '');
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined;
  const authFail = (r: Response) => { if (r.status === 401 || r.status === 403) throw Object.assign(new Error('LM Studio asks for an API token (authentication is on). Paste the token from LM Studio → Developer → Server settings.'), { status: r.status, auth: true }); };
  try {
    const r = await fetch(`${base}/api/v1/models`, { headers, signal: AbortSignal.timeout(4000) });
    authFail(r);
    if (r.ok) {
      const j: any = await r.json();
      if (Array.isArray(j.models)) return {
        flavor: 'lmstudio', api: 'v1', models: j.models.map((m: any): LocalModel => {
          const inst = Array.isArray(m.loaded_instances) ? m.loaded_instances : [];
          return {
            id: m.key, type: m.type === 'embedding' ? 'embeddings' : (m.type ?? 'llm'), state: inst.length ? 'loaded' : 'not-loaded',
            contextLength: m.max_context_length, loadedContext: inst[0]?.config?.context_length, instances: inst.map((i: any) => i.id),
            sizeBytes: m.size_bytes, params: m.params_string ?? undefined, tools: m.capabilities?.trained_for_tool_use, vision: m.capabilities?.vision,
            quantization: m.quantization?.name ?? undefined, arch: m.architecture ?? undefined, publisher: m.publisher, displayName: m.display_name,
          };
        }),
      };
    }
  } catch (e) { if ((e as any).auth) throw e; /* older LM Studio, or not LM Studio */ }
  try {
    const r = await fetch(`${base}/api/v0/models`, { headers, signal: AbortSignal.timeout(4000) });
    authFail(r);
    if (r.ok) {
      const j: any = await r.json();
      return { flavor: 'lmstudio', api: 'v0', models: (j.data ?? []).map((m: any) => ({ id: m.id, type: m.type === 'embedding' ? 'embeddings' : (m.type ?? 'llm'), state: m.state ?? 'unknown', arch: m.arch, quantization: m.quantization, publisher: m.publisher, contextLength: m.max_context_length ?? m.loaded_context_length, loadedContext: m.loaded_context_length })) };
    }
  } catch (e) { if ((e as any).auth) throw e; /* not LM Studio, or not reachable */ }
  const r = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(4000) });
  authFail(r);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j: any = await r.json();
  return { flavor: 'openai', api: 'openai', models: (j.data ?? []).map((m: any) => ({ id: m.id, type: /embed/i.test(m.id) ? 'embeddings' : 'llm', state: 'unknown' })) };
}
