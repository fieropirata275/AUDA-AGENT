/**
 * Unit tests for zero-touch LM Studio's decisions: reading LM Studio's v1 model
 * list, sizing models against this machine's memory, ranking them for agents,
 * choosing a context length, suggesting downloads, and classifying failures
 * so the right fix is applied. (The full flow runs in scripts/e2e-lmstudio.mjs.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.AUDA_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-lms-test-'));

const { rankModels, pickAgentModel, pickContext, suggest, paramsB, estimateGb, classifyLocalError, isLocalUrl } = await import('../src/connectors/lmstudio-setup.ts');
const { listModels } = await import('../src/models/openai.ts');

const hw = (o: Partial<any> = {}) => ({ platform: 'linux', arch: 'x64', cpu: 'x', cores: 8, totalGb: 32, freeGb: 20, gpus: [{ name: 'GPU', vramGb: 12 }], unified: false, fastGb: 11, maxGb: 27, summary: '', ...o });

test('parameters and memory are read from LM Studio’s fields or the model name', () => {
  assert.deepEqual(paramsB({ id: 'qwen/qwen3-30b-a3b' }), { total: 30, active: 3 });
  assert.deepEqual(paramsB({ id: 'x', params: '7B' }), { total: 7, active: undefined });
  assert.equal(paramsB({ id: 'llama-3.1-8b-instruct' }).total, 8, 'a version number is not a parameter count');
  assert.equal(estimateGb({ id: 'a', type: 'llm', state: 'loaded', sizeBytes: 5e9 }), 5.5);
  assert.equal(estimateGb({ id: 'mistral-7b', type: 'llm', state: 'x', quantization: 'Q8_0' }), 8.2);
});

test('ranking prefers tool-calling models that fit, and never offers one that cannot run', () => {
  const ranked = rankModels([
    { id: 'tiny-chat-1b', type: 'llm', state: 'loaded', sizeBytes: 0.8e9, tools: false, contextLength: 4096 },
    { id: 'qwen/qwen3-8b', type: 'llm', state: 'not-loaded', sizeBytes: 5e9, tools: true, contextLength: 40960 },
    { id: 'openai/gpt-oss-120b', type: 'llm', state: 'not-loaded', sizeBytes: 65e9, tools: true, contextLength: 131072 },
    { id: 'my-llama-3.1-8b-instruct', type: 'llm', state: 'not-loaded', sizeBytes: 4.9e9, contextLength: 131072 },
    { id: 'text-embedding-nomic', type: 'embeddings', state: 'not-loaded' },
  ], hw());
  assert.equal(ranked[0].id, 'qwen/qwen3-8b');
  assert.equal(ranked.find((r) => r.id === 'my-llama-3.1-8b-instruct')!.tools, 'likely', 'known families are likely to call tools');
  assert.equal(ranked.find((r) => r.id === 'openai/gpt-oss-120b')!.fits, 'no');
  assert.ok(!ranked.some((r) => r.id.includes('embedding')), 'embedding models are not chat models');
  assert.deepEqual(pickAgentModel(ranked).map((r) => r.id), ['qwen/qwen3-8b', 'my-llama-3.1-8b-instruct']);
  // A model that is already loaded is running, whatever the estimate says.
  const loadedBig = rankModels([{ id: 'big-70b', type: 'llm', state: 'loaded', sizeBytes: 40e9, tools: true }], hw());
  assert.equal(loadedBig[0].fits, 'slow');
});

test('context: room for an agent within the model’s limit and the memory left over', () => {
  assert.equal(pickContext({ context: 40960, gb: 5 }, hw({ fastGb: 22 })), 32768);
  assert.equal(pickContext({ context: 131072, gb: 5 }, hw({ fastGb: 40 })), 65536, 'lots of headroom → a bigger window');
  assert.equal(pickContext({ context: 40960, gb: 9.5 }, hw({ fastGb: 11 })), 8192, 'tight memory → a small window');
  assert.equal(pickContext({ context: 8192 }, null), 8192, 'never above the model’s limit');
});

test('suggestions are sized for the machine', () => {
  assert.equal(suggest(hw({ gpus: [{ name: 'g', vramGb: 24 }], fastGb: 22 }))[0].key, 'google/gemma-4-26b-a4b');
  assert.equal(suggest(hw({ gpus: [], unified: false, totalGb: 8, fastGb: 3.2, maxGb: 4.8 }))[0].key, 'qwen/qwen3-4b-2507');
  assert.equal(suggest(hw({ gpus: [], unified: true, totalGb: 128, fastGb: 89.6, maxGb: 89.6 }))[0].key, 'openai/gpt-oss-120b');
  const s = suggest(null);
  assert.ok(s[0].recommended && s.length === 2);
});

test('failures are classified so the right fix is applied', () => {
  assert.equal(classifyLocalError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), 'down');
  assert.equal(classifyLocalError(new Error('Local model HTTP 400: {"error":"The number of tokens to keep from the initial prompt is greater than the context length."}')), 'context');
  assert.equal(classifyLocalError(new Error('Local model HTTP 400: Model "x" is not loaded.')), 'not-loaded');
  assert.equal(classifyLocalError(new Error('Local model HTTP 500: out of memory')), 'other');
  assert.ok(isLocalUrl('http://127.0.0.1:1234') && isLocalUrl('http://localhost:1234') && !isLocalUrl('http://10.255.1.9:1234'));
});

test('listModels reads LM Studio 0.4’s v1 list, and says so when a token is required', async () => {
  let auth = false;
  const srv = http.createServer((req, res) => {
    if (auth && req.headers.authorization !== 'Bearer t') { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    if (req.url === '/api/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [
      { type: 'llm', key: 'qwen/qwen3-8b', size_bytes: 5e9, params_string: '8B', max_context_length: 40960, loaded_instances: [{ id: 'qwen/qwen3-8b', config: { context_length: 16384 } }], capabilities: { trained_for_tool_use: true, vision: false }, quantization: { name: 'Q4_K_M' } },
      { type: 'embedding', key: 'nomic', size_bytes: 8e7, max_context_length: 2048, loaded_instances: [] },
    ] })); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const r = await listModels(base);
    assert.equal(r.api, 'v1');
    assert.deepEqual(r.models[0], { id: 'qwen/qwen3-8b', type: 'llm', state: 'loaded', contextLength: 40960, loadedContext: 16384, instances: ['qwen/qwen3-8b'], sizeBytes: 5e9, params: '8B', tools: true, vision: false, quantization: 'Q4_K_M', arch: undefined, publisher: undefined, displayName: undefined });
    assert.equal(r.models[1].type, 'embeddings');
    auth = true;
    await assert.rejects(listModels(base), /API token/);
    assert.equal((await listModels(base, 't')).models.length, 2);
  } finally { srv.close(); }
});
