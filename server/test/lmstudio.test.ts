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

const { rankModels, pickAgentModel, suggest, classifyLocalError, isLocalUrl } = await import('../src/connectors/lmstudio-setup.ts');
const { profile, gpuBandwidth } = await import('../src/connectors/hardware.ts');
const { listModels } = await import('../src/models/openai.ts');

const cpu = (o: object = {}) => ({ model: 'x', vendor: '', arch: 'x64', physicalCores: 8, threads: 16, avx2: true, avx512: false, amx: false, neon: false, ...o });
const gpu = (vendor: any, name: string, vramGb: number) => ({ vendor, name, vramGb, backend: vendor === 'nvidia' ? 'cuda' : vendor === 'apple' ? 'metal' : 'rocm', bandwidthGBs: gpuBandwidth(vendor, name, vramGb) } as any);
const machine = (gpus: any[], ramGb = 32, o: object = {}) => profile({ platform: 'linux', arch: 'x64', cpu: cpu(o), ram: { totalGb: ramGb, freeGb: ramGb / 2, bandwidthGBs: 60 }, gpus, unified: false });

test('ranking prefers tool-calling models that fit, and never offers one that cannot run', () => {
  const ranked = rankModels([
    { id: 'tiny-chat-1b', type: 'llm', state: 'loaded', sizeBytes: 0.8e9, tools: false, contextLength: 4096 },
    { id: 'qwen/qwen3-8b', type: 'llm', state: 'not-loaded', sizeBytes: 5e9, tools: true, contextLength: 40960 },
    { id: 'openai/gpt-oss-120b', type: 'llm', state: 'not-loaded', sizeBytes: 65e9, tools: true, contextLength: 131072 },
    { id: 'my-llama-3.1-8b-instruct', type: 'llm', state: 'not-loaded', sizeBytes: 4.9e9, contextLength: 131072 },
    { id: 'text-embedding-nomic', type: 'embeddings', state: 'not-loaded' },
  ], machine([gpu('nvidia', 'NVIDIA GeForce RTX 3060', 12)], 16), 'balanced');
  assert.equal(ranked[0].id, 'qwen/qwen3-8b');
  assert.ok(ranked[0].tps! > 20 && ranked[0].placement === 'gpu' && ranked[0].load?.flash_attention, 'the winner runs on the GPU with flash attention');
  assert.equal(ranked.find((r) => r.id === 'my-llama-3.1-8b-instruct')!.tools, 'likely', 'known families are likely to call tools');
  assert.equal(ranked.find((r) => r.id === 'openai/gpt-oss-120b')!.fits, 'no');
  assert.ok(!ranked.some((r) => r.id.includes('embedding')), 'embedding models are not chat models');
  assert.deepEqual(pickAgentModel(ranked).map((r) => r.id), ['qwen/qwen3-8b', 'my-llama-3.1-8b-instruct']);
  const loadedBig = rankModels([{ id: 'big-70b', type: 'llm', state: 'loaded', sizeBytes: 40e9, tools: true }], machine([gpu('nvidia', 'RTX 3060', 12)], 16));
  assert.equal(loadedBig[0].fits, 'slow', 'a loaded model is running, whatever the estimate says');
});

test('suggestions are planned for the machine, with speed, quantization, context and placement', () => {
  const big = suggest(machine([gpu('nvidia', 'NVIDIA GeForce RTX 4090', 24)], 64), 'balanced');
  assert.ok(big[0].recommended && big[0].placement === 'gpu' && big[0].tps! >= 20 && big[0].context! >= 32768, JSON.stringify(big[0]));
  const tiny = suggest(machine([], 8, { physicalCores: 4, threads: 8 }), 'balanced');
  assert.ok(tiny.length && tiny[0].gb < 4 && tiny[0].meets === false, 'an 8 GB CPU-only laptop gets a tiny model, flagged as slow');
  assert.equal(suggest(null)[0].key, 'qwen/qwen3-8b', 'unknown hardware (a server elsewhere) → a safe middle choice');
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
