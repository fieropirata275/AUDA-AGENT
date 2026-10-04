/**
 * A stand-in for LM Studio's headless server (`lms server start`) used by
 * e2e-lan.mjs. It implements the endpoints AUDA uses — /api/v0/models,
 * /v1/models and /v1/chat/completions with OpenAI-style tool calls — and
 * deliberately behaves like a quirky local model on some turns (tool calls
 * written into the text, trailing commas in JSON) to exercise AUDA's parsing.
 */
import http from 'node:http';

export function startFakeLmStudio(port) {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/api/v0/models') return send(200, { object: 'list', data: [
      { id: 'qwen3-coder-30b', object: 'model', type: 'llm', publisher: 'qwen', arch: 'qwen3', quantization: 'Q4_K_M', state: 'loaded', max_context_length: 32768 },
      { id: 'tiny-chat-1b', object: 'model', type: 'llm', state: 'not-loaded', max_context_length: 4096 },
      { id: 'nomic-embed-text', object: 'model', type: 'embeddings', state: 'not-loaded' },
    ] });
    if (req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: 'qwen3-coder-30b' }, { id: 'tiny-chat-1b' }, { id: 'nomic-embed-text' }] });
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') return send(404, { error: 'not found' });
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    calls++;
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
