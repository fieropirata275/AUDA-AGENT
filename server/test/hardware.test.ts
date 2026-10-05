/**
 * Unit tests for hardware profiling and model planning: parsing what the OS
 * reports (nvidia-smi, /proc/cpuinfo, dmidecode, the Windows registry), the
 * memory budgets and bandwidth that follow, and the planner's choices across
 * very different machines — from an 8 GB CPU-only laptop to a 512 GB Mac.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseNvidiaSmi, parseCpuinfo, parseDmidecode, parseWindowsAdapters, ramBandwidth, gpuBandwidth, profile } = await import('../src/connectors/hardware.ts');
const { planDownloads, evaluate, CATALOG, specFor } = await import('../src/connectors/model-planner.ts');

test('nvidia-smi: every GPU with memory, compute capability and bandwidth', () => {
  const g = parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564, 23000, 8.9\nNVIDIA GeForce RTX 3060 Laptop GPU, 6144, 5900, 8.6\n');
  assert.equal(g.length, 2);
  assert.deepEqual([g[0].vramGb, g[0].bandwidthGBs, g[0].computeCap, g[0].backend], [24, 1008, '8.9', 'cuda']);
  assert.ok(g[1].bandwidthGBs < 360, 'laptop parts run below the desktop card');
});

test('/proc/cpuinfo: physical cores, threads and vector extensions', () => {
  const block = (p: number, c: number) => `processor\t: ${p}\nvendor_id\t: AuthenticAMD\nmodel name\t: AMD Ryzen 9 7950X 16-Core Processor\nphysical id\t: 0\ncore id\t\t: ${c}\nflags\t\t: fpu sse avx avx2 fma avx512f avx512bw\n\n`;
  const text = Array.from({ length: 32 }, (_, i) => block(i, i % 16)).join('');
  const c = parseCpuinfo(text);
  assert.deepEqual([c.physicalCores, c.threads, c.avx2, c.avx512, c.amx], [16, 32, true, true, false]);
  assert.equal(c.model, 'AMD Ryzen 9 7950X 16-Core Processor');
  assert.equal(parseCpuinfo('processor : 0\nFeatures : fp asimd evtstrm\n').neon, true);
});

test('dmidecode and RAM bandwidth: DDR5-5600 dual channel ≈ 76 GB/s; servers get more channels', () => {
  const dimm = (s: string) => `Memory Device\n\tSize: 32 GB\n\tType: DDR5\n\tSpeed: 5600 MT/s\n\tConfigured Memory Speed: ${s} MT/s\n`;
  const d = parseDmidecode(['# dmidecode', dimm('5600'), dimm('5600'), 'Memory Device\n\tSize: No Module Installed\n'].join('\n'));
  assert.deepEqual(d, { kind: 'DDR5', speedMTs: 5600, modules: 2 });
  assert.equal(ramBandwidth({ ...d, threads: 32, platform: 'linux' }).bandwidthGBs, 76);
  assert.ok(ramBandwidth({ kind: 'DDR5', speedMTs: 4800, modules: 12, threads: 128, platform: 'linux' }).bandwidthGBs > 300);
  assert.equal(ramBandwidth({ threads: 8, platform: 'win32' }).bandwidthGBs, 45, 'unknown RAM → a laptop-class default');
});

test('Windows adapters: discrete AMD/Intel cards counted, integrated and virtual ones not', () => {
  const g = parseWindowsAdapters(JSON.stringify([
    { DriverDesc: 'AMD Radeon RX 7900 XTX', 'HardwareInformation.qwMemorySize': 25753026560 },
    { DriverDesc: 'Intel(R) UHD Graphics 770', 'HardwareInformation.qwMemorySize': 134217728 },
    { DriverDesc: 'Intel(R) Arc(TM) B580 Graphics', 'HardwareInformation.qwMemorySize': 0 },
    { DriverDesc: 'NVIDIA GeForce RTX 4070', 'HardwareInformation.qwMemorySize': 12884901888 },
    { DriverDesc: 'Microsoft Basic Display Adapter' },
  ]));
  assert.deepEqual(g.map((x) => [x.name.split(' ').slice(-2).join(' '), x.vramGb, !!x.integrated]), [['7900 XTX', 24, false], ['Graphics 770', 0.1, true], ['B580 Graphics', 12, false]]);
  assert.equal(g[0].bandwidthGBs, 960);
});

const cpu = (o: object = {}) => ({ model: 'x', vendor: '', arch: 'x64', physicalCores: 8, threads: 16, avx2: true, avx512: false, amx: false, neon: false, ...o });
const gpu = (vendor: any, name: string, vramGb: number) => ({ vendor, name, vramGb, backend: vendor === 'nvidia' ? 'cuda' : vendor === 'apple' ? 'metal' : 'rocm', bandwidthGBs: gpuBandwidth(vendor, name, vramGb) } as any);
const pc = (gpus: any[], ramGb: number, o: object = {}) => profile({ platform: 'linux', arch: 'x64', cpu: cpu(o), ram: { totalGb: ramGb, freeGb: ramGb / 2, bandwidthGBs: 60 }, gpus, unified: false });
const mac = (chip: string, ramGb: number) => profile({ platform: 'darwin', arch: 'arm64', cpu: cpu({ arch: 'arm64', neon: true, avx2: false }), ram: { totalGb: ramGb, freeGb: ramGb / 2, bandwidthGBs: gpuBandwidth('apple', chip, 0) }, gpus: [gpu('apple', chip, ramGb * (ramGb > 36 ? 0.75 : 0.67))], unified: true });

test('profiles: budgets and backends follow the hardware', () => {
  const p = pc([gpu('nvidia', 'NVIDIA GeForce RTX 3090', 24), gpu('nvidia', 'NVIDIA GeForce RTX 3090', 24)], 128);
  assert.equal(p.backend, 'cuda'); assert.ok(p.fastGb > 42 && p.maxGb > 120 && p.tier === 'high');
  assert.ok(p.notes.some((n) => /2 GPUs/.test(n)));
  const m = mac('Apple M3 Max', 64);
  assert.equal(m.backend, 'metal'); assert.equal(m.bandwidth.fast, 400); assert.equal(m.fastGb, m.maxGb);
  const cpuOnly = pc([], 16);
  assert.equal(cpuOnly.backend, 'cpu'); assert.ok(cpuOnly.notes.some((n) => /No GPU/.test(n)));
});

test('estimates: decode speed follows bandwidth ÷ bytes per token; MoE reads only active experts', () => {
  const hw = pc([gpu('nvidia', 'NVIDIA GeForce RTX 4090', 24)], 64);
  const dense = evaluate(CATALOG.find((c) => c.key === 'qwen/qwen3-14b')!, 'Q4_K_M', 32768, hw, 'balanced')!;
  const moe = evaluate(CATALOG.find((c) => c.key === 'qwen/qwen3-30b-a3b-2507')!, 'Q4_K_M', 32768, hw, 'balanced')!;
  assert.ok(dense.tps > 50 && dense.tps < 120, `14B on a 4090: ${dense.tps}`);
  assert.ok(moe.tps > dense.tps, 'a 30B MoE with 3B active is faster than a dense 14B');
  const q8 = evaluate(CATALOG.find((c) => c.key === 'qwen/qwen3-14b')!, 'Q8_0', 32768, hw, 'balanced')!;
  assert.ok(q8.tps < dense.tps && q8.quality > dense.quality, 'higher precision: smarter, slower');
  const split = evaluate(CATALOG.find((c) => c.key === 'qwen/qwen3-32b')!, 'Q8_0', 32768, hw, 'smart')!;
  assert.equal(split.placement, 'split'); assert.ok(split.gpuShare > 0.3 && split.gpuShare < 1 && split.load.gpu === split.gpuShare);
  assert.equal(evaluate(CATALOG.find((c) => c.key === 'openai/gpt-oss-120b')!, 'MXFP4', 32768, pc([gpu('nvidia', 'RTX 3060', 12)], 16), 'smart'), null, 'too big → not offered');
});

test('plans: the right model for each kind of machine', () => {
  const plan = (hw: any, pref: any = 'balanced') => planDownloads(hw, pref).best!;
  // A 24 GB GPU: a fast, capable model entirely on the GPU, with a long context.
  const p4090 = plan(pc([gpu('nvidia', 'NVIDIA GeForce RTX 4090', 24)], 64));
  assert.ok(p4090.placement === 'gpu' && p4090.quality >= 68 && p4090.tps >= 60 && p4090.context >= 32768, JSON.stringify(p4090));
  // Fastest never picks a slower model than Smartest.
  const hw3060 = pc([gpu('nvidia', 'NVIDIA GeForce RTX 3060', 12)], 32);
  assert.ok(plan(hw3060, 'fast').tps >= plan(hw3060, 'smart').tps);
  assert.ok(plan(hw3060, 'smart').quality >= plan(hw3060, 'fast').quality);
  // Apple silicon: MLX quantizations, sized to unified memory.
  const m3 = plan(mac('Apple M3 Max', 64), 'smart');
  assert.ok(m3.format === 'mlx' || m3.quant === 'MXFP4');
  assert.equal(plan(mac('Apple M3 Ultra', 512), 'smart').key, 'qwen/qwen3-235b-a22b', 'a 512 GB Mac runs the biggest model');
  // A small CPU-only laptop: a tiny model, honestly flagged as slow.
  const lap = planDownloads(pc([], 8, { physicalCores: 4, threads: 8 }), 'balanced');
  assert.ok(lap.best && lap.best.weightsGb < 3 && lap.belowTarget);
  // A many-core server without a GPU: mixture of experts, because only active parameters are read.
  const srv = plan(pc([], 256, { physicalCores: 64, threads: 128, avx512: true }) as any);
  assert.ok(CATALOG.find((c) => c.key === srv.key)!.activeB < 10, `server pick ${srv.key}`);
  // Every plan carries load settings for LM Studio.
  assert.equal(p4090.load.flash_attention, true); assert.equal(p4090.load.offload_kv_cache_to_gpu, true); assert.ok(p4090.load.eval_batch_size! >= 1024);
});

test('downloaded models get a spec from the catalog or from their size and name', () => {
  const s = specFor({ id: 'lmstudio-community/qwen3-14b', type: 'llm', state: 'x', sizeBytes: 9e9, params: '14B', quantization: 'Q4_K_M' })!;
  assert.equal(s.quality, CATALOG.find((c) => c.key === 'qwen/qwen3-14b')!.quality);
  const u = specFor({ id: 'someone/mystery-model-12b', type: 'llm', state: 'x', sizeBytes: 7.3e9 })!;
  assert.equal(u.totalB, 12); assert.ok(u.quality > 50 && u.quality < 70);
});
