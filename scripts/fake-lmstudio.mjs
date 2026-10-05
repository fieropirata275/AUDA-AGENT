/**
 * A stand-in for LM Studio's headless server (`lms server start`) used by the
 * e2e suites. It implements the endpoints AUDA uses — the v1 REST API (0.4+:
 * models with capabilities and loaded instances, load with a context length,
 * unload, download with progress), /api/v0/models, /v1/models and
 * /v1/chat/completions with OpenAI-style tool calls — and behaves like LM
 * Studio where it matters: with JIT off an unloaded model is an error, a prompt
 * larger than the loaded context is an error, and a load bigger than memory
 * allows fails. Some turns are deliberately quirky (tool calls written into the
 * text, trailing commas in JSON) to exercise AUDA's parsing.
 *
 * Options: { models, jit = true, maxLoadContext, statePath }. With statePath,
 * the model list (downloads included) survives a restart; loads don't.
 * Test hooks: POST /__evict, /__shrink {context}, /__close; GET /__state.
 */
import fs from 'node:fs';
import http from 'node:http';

const DEFAULT_MODELS = () => [
  { key: 'qwen3-coder-30b', type: 'llm', publisher: 'qwen', arch: 'qwen3', quantization: 'Q4_K_M', params: '30B-A3B', size: 18.6e9, tools: true, max: 32768, loaded: 32768 },
  { key: 'tiny-chat-1b', type: 'llm', size: 0.8e9, params: '1B', tools: false, max: 4096, loaded: 0 },
  { key: 'nomic-embed-text', type: 'embedding', size: 0.08e9, max: 2048, loaded: 0 },
];

export function startFakeLmStudio(port, opts = {}) {
  let calls = 0, jobs = 0;
  const saved = opts.statePath && fs.existsSync(opts.statePath) ? JSON.parse(fs.readFileSync(opts.statePath, 'utf8')) : null;
  const models = saved ? saved.map((m) => ({ ...m, loaded: 0 })) : (opts.models ?? DEFAULT_MODELS()).map((m) => ({ ...m }));
  const persist = () => { if (opts.statePath) fs.writeFileSync(opts.statePath, JSON.stringify(models)); };
  persist();
  const downloads = new Map();
  const loads = [];
  const find = (key) => models.find((m) => m.key === key);
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = req.url.split('?')[0];
    // ── test hooks ──
    if (url === '/__state') return send(200, { models, loads, calls, downloads: [...downloads.values()] });
    if (url === '/__evict') { for (const m of models) m.loaded = 0; return send(200, { ok: true }); }
    if (url === '/__shrink') { const m = models.find((x) => x.loaded); if (m) m.loaded = body.context ?? 1024; return send(200, { ok: true, model: m?.key }); }
    if (url === '/__close') { send(200, { ok: true }); setTimeout(() => { server.closeAllConnections?.(); server.close(); opts.onClose?.(); }, 50); return; }
    // ── v1 REST API (LM Studio 0.4+) ──
    if (url === '/api/v1/models' && req.method === 'GET') return send(200, { models: models.map((m) => ({
      type: m.type, publisher: m.publisher ?? 'test', key: m.key, display_name: m.key, architecture: m.type === 'llm' ? (m.arch ?? 'llama') : undefined,
      quantization: { name: m.quantization ?? 'Q4_K_M', bits_per_weight: 4 }, size_bytes: m.size, params_string: m.params ?? null,
      loaded_instances: m.loaded ? [{ id: m.key, config: { context_length: m.loaded } }] : [], max_context_length: m.max, format: 'gguf',
      ...(m.type === 'llm' ? { capabilities: { vision: false, trained_for_tool_use: !!m.tools } } : {}),
    })) });
    if (url === '/api/v1/models/load' && req.method === 'POST') {
      const m = find(body.model);
      if (!m) return send(404, { error: `Model "${body.model}" not found` });
      const ctx = body.context_length ?? 4096;
      if (opts.maxLoadContext && ctx > opts.maxLoadContext && m.type === 'llm') return send(400, { error: `Failed to load model: insufficient system resources for a ${ctx}-token context` });
      m.loaded = Math.min(ctx, m.max); loads.push({ model: m.key, context: m.loaded });
      return send(200, { type: m.type, instance_id: m.key, load_time_seconds: 0.4, status: 'loaded', ...(body.echo_load_config ? { load_config: { context_length: m.loaded } } : {}) });
    }
    if (url === '/api/v1/models/unload' && req.method === 'POST') { const m = find(body.instance_id); if (m) m.loaded = 0; return send(200, { instance_id: body.instance_id }); }
    if (url === '/api/v1/models/download' && req.method === 'POST') {
      if (find(body.model)) return send(200, { status: 'already_downloaded' });
      const id = `job_${++jobs}`, total = 5e9;
      downloads.set(id, { job_id: id, model: body.model, status: 'downloading', total_size_bytes: total, downloaded_bytes: 0, polls: 0, started_at: new Date().toISOString() });
      return send(200, { job_id: id, status: 'downloading', total_size_bytes: total, started_at: new Date().toISOString() });
    }
    if (url.startsWith('/api/v1/models/download/status/')) {
      const d = downloads.get(decodeURIComponent(url.split('/').pop()));
      if (!d) return send(404, { error: 'no such job' });
      d.polls++;
      d.downloaded_bytes = Math.min(d.total_size_bytes, d.polls * 0.6e9);
      if (d.downloaded_bytes >= d.total_size_bytes && d.status !== 'completed') {
        d.status = 'completed'; d.completed_at = new Date().toISOString();
        const name = d.model.split('/').pop();
        models.push({ key: d.model, type: 'llm', publisher: d.model.split('/')[0], params: (/(\d+b)/i.exec(name)?.[1] ?? '8B').toUpperCase(), size: 5e9, tools: true, max: 40960, loaded: 0 });
        persist();
      }
      const { polls: _p, model: _m, ...pub } = d;
      return send(200, { ...pub, ...(d.status === 'downloading' ? { bytes_per_second: 1.7e9, estimated_completion: new Date(Date.now() + 2000).toISOString() } : {}) });
    }
    // ── v0 and OpenAI-compatible ──
    if (url === '/api/v0/models') return send(200, { object: 'list', data: models.map((m) => ({ id: m.key, object: 'model', type: m.type === 'embedding' ? 'embeddings' : m.type, publisher: m.publisher, arch: m.arch, quantization: m.quantization, state: m.loaded ? 'loaded' : 'not-loaded', max_context_length: m.max })) });
    if (url === '/v1/models') return send(200, { object: 'list', data: models.filter((m) => opts.jit !== false || m.loaded).map((m) => ({ id: m.key })) });
    if (url !== '/v1/chat/completions' || req.method !== 'POST') return send(404, { error: 'not found' });
    calls++;
    const target = find(body.model);
    if (!target) return send(404, { error: { message: `Model "${body.model}" not found`, type: 'invalid_request_error' } });
    if (!target.loaded) {
      if (opts.jit === false) return send(400, { error: { message: `Model "${body.model}" is not loaded. Load it first, or turn on Just-in-Time loading.` } });
      target.loaded = 4096; // a JIT load uses a small default context, as LM Studio does
    }
    if (JSON.stringify(body.messages).length / 4 > target.loaded) return send(400, { error: { message: 'The number of tokens to keep from the initial prompt is greater than the context length.' } });
    const msgs = body.messages;
    const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
    const tools = (body.tools ?? []).map((t) => t.function.name);
    const reply = (message, finish = 'stop') => send(200, { id: `chatcmpl-${calls}`, object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
    const call = (name, args, rawArgs) => ({ id: `call_${calls}_${name}`, type: 'function', function: { name, arguments: rawArgs ?? JSON.stringify(args) } });

    if (body.model === 'tiny-chat-1b') return reply({ content: 'I can only chat.' }); // no tool calling
    if (tools.includes('report')) return reply({ content: null, tool_calls: [call('report', { status: 'ok', count: 3 })] }, 'tool_calls');
    if (/strict, fair reviewer/.test(sys)) return reply({ content: '<think>checking the evidence</think>{"verdict":"pass","issues":[],"summary":"The counter was run and printed 3."}' });
    if (/Summarise an autonomous agent/.test(sys)) return reply({ content: 'Progress summary.' });

    const first = msgs.find((m) => m.role === 'user')?.content ?? '';
    const turn = msgs.filter((m) => m.role === 'assistant').length;
    if (/Task: Count words locally/.test(first)) {
      // Turn 0: proper tool calls, one with a trailing comma (lenient parsing).
      if (turn === 0) return reply({ content: null, tool_calls: [call('write_file', null, '{"path": "wc.py", "content": "import sys\\nprint(len(sys.stdin.read().split()))\\n",}')] }, 'tool_calls');
      // Turn 1: the model writes the tool call into its text instead of tool_calls.
      if (turn === 1) return reply({ content: 'Let me run it.\n<tool_call>{"name": "terminal", "arguments": {"cmd": "printf \'x y z\' | python3 wc.py", "why": "Run it"}}</tool_call>' });
      const out = [...msgs].reverse().find((m) => m.role === 'tool')?.content ?? '';
      return reply({ content: `<think>done</think>Done locally: wc.py printed ${/stdout ---\n(\d+)/.exec(out)?.[1] ?? '?'} for "x y z".` });
    }
    if (/Task: Long job with check-ins/.test(first)) {
      const heard = msgs.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
      const said = /Message from [^\n]*\n([^\n]+)/.exec(heard)?.[1];
      const replied = msgs.some((m) => m.role === 'assistant' && (m.tool_calls ?? []).some((c) => c.function.name === 'reply_to_user'));
      if (turn === 0) return reply({ content: null, tool_calls: [call('terminal', { cmd: 'sleep 5 && echo phase-one', why: 'First phase', timeout_sec: 30 })] }, 'tool_calls');
      if (said && !replied) return reply({ content: null, tool_calls: [call('reply_to_user', { text: `Got it — ${said}` })] }, 'tool_calls');
      return reply({ content: said ? `Finished, with your note applied: ${said}` : 'Finished without any messages.' });
    }
    if (/Task: Summarise the attached file/.test(first)) {
      const file = /- (~\/inbox\/\S+)/.exec(first)?.[1];
      if (turn === 0) return reply({ content: null, tool_calls: [call('read_file', { path: file })] }, 'tool_calls');
      const content = [...msgs].reverse().find((m) => m.role === 'tool')?.content ?? '';
      return reply({ content: `The file says: ${content.split('\n').slice(1).join(' ').trim()}` });
    }
    return reply({ content: 'OK.' });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, stats: () => ({ calls }) })));
}
