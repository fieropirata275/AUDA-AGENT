/**
 * Model planner: which model, quantization, context and load settings make the
 * best agent on *this* machine.
 *
 * It predicts, for each candidate configuration:
 *  - memory: weights (parameters × bits per weight) + KV cache (per-token cost
 *    × context) + runtime overhead → all on the GPU, split GPU/RAM, or CPU;
 *  - decode speed: tokens/s ≈ bandwidth ÷ bytes read per token (active
 *    parameters for mixture-of-experts), mixing GPU and RAM bandwidth when the
 *    model is split, scaled by backend efficiency and by what AUDA has measured
 *    on this machine before;
 *  - prompt speed, and the time of a typical agent turn (≈1.5k new prompt
 *    tokens in, 250 out) — what you actually feel waiting.
 *
 * Then it picks the highest-quality configuration that meets the speed target
 * of the chosen preference (Fastest / Balanced / Smartest), and the load
 * settings that go with it: flash attention, where the KV cache lives, batch
 * size, and the GPU share when the model doesn't fit.
 */
import type { Backend, Hardware } from './hardware.ts';
import type { LocalModel } from '../models/openai.ts';

export type Preference = 'fast' | 'balanced' | 'smart';
export const TARGETS: Record<Preference, { tps: number; turn: number; label: string }> = {
  fast: { tps: 40, turn: 6, label: 'Fastest' },
  balanced: { tps: 20, turn: 12, label: 'Balanced' },
  smart: { tps: 8, turn: 35, label: 'Smartest' },
};

export type Quant = 'Q3_K_M' | 'Q4_K_M' | 'Q5_K_M' | 'Q6_K' | 'Q8_0' | 'MXFP4';
const BITS: Record<Quant, number> = { Q3_K_M: 3.9, Q4_K_M: 4.85, Q5_K_M: 5.7, Q6_K: 6.6, Q8_0: 8.5, MXFP4: 4.25 };
const MLX_BITS: Partial<Record<Quant, number>> = { Q3_K_M: 3.5, Q4_K_M: 4.5, Q6_K: 6.5, Q8_0: 8.5, MXFP4: 4.25 };
const MLX_NAME: Partial<Record<Quant, string>> = { Q3_K_M: '3bit', Q4_K_M: '4bit', Q6_K: '6bit', Q8_0: '8bit', MXFP4: 'MXFP4' };
/** Quality lost to quantization, in the same points as ModelSpec.quality. */
const QUANT_COST: Record<Quant, number> = { Q8_0: 0, MXFP4: 0, Q6_K: 0.5, Q5_K_M: 1.2, Q4_K_M: 2.5, Q3_K_M: 7 };

export interface ModelSpec {
  key: string; name: string;
  totalB: number; activeB: number;
  /** KV cache per token at fp16, MB (layers × KV heads × head dim × 2 × 2 bytes). */
  kvMB: number;
  maxContext: number;
  /** Agentic quality (tool use, instruction following, reasoning) on a 0–100 scale. */
  quality: number;
  vision?: boolean;
  /** Fixed file size (models published in one native quantization). */
  fixedGb?: number;
  quants: Quant[];
  why: string;
}

/** Tool-calling models in LM Studio's catalog, with the architecture numbers the estimates need. */
export const CATALOG: ModelSpec[] = [
  { key: 'ibm/granite-4-micro', name: 'Granite 4 Micro', totalB: 3.2, activeB: 3.2, kvMB: 0.16, maxContext: 131072, quality: 38, quants: ['Q4_K_M', 'Q8_0'], why: 'Tiny and quick; fine for simple tasks on modest machines.' },
  { key: 'qwen/qwen3-4b-2507', name: 'Qwen3 4B', totalB: 4.0, activeB: 4.0, kvMB: 0.14, maxContext: 262144, quality: 50, quants: ['Q4_K_M', 'Q6_K', 'Q8_0'], why: 'Small, quick, and reliable with tools for its size.' },
  { key: 'qwen/qwen3-8b', name: 'Qwen3 8B', totalB: 8.2, activeB: 8.2, kvMB: 0.14, maxContext: 40960, quality: 58, quants: ['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0'], why: 'A dependable all-rounder for agents.' },
  { key: 'qwen/qwen3-14b', name: 'Qwen3 14B', totalB: 14.8, activeB: 14.8, kvMB: 0.16, maxContext: 40960, quality: 64, quants: ['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0'], why: 'Noticeably sharper reasoning than 8B, still quick on a mid-range GPU.' },
  { key: 'openai/gpt-oss-20b', name: 'gpt-oss 20B', totalB: 21, activeB: 3.6, kvMB: 0.05, maxContext: 131072, quality: 70, fixedGb: 12.1, quants: ['MXFP4'], why: 'Strong reasoning and tool use; mixture of experts, so it runs fast.' },
  { key: 'qwen/qwen3-30b-a3b-2507', name: 'Qwen3 30B A3B', totalB: 30.5, activeB: 3.3, kvMB: 0.094, maxContext: 262144, quality: 69, quants: ['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0'], why: 'Big-model knowledge at small-model speed (3B active), long context.' },
  { key: 'google/gemma-4-26b-a4b', name: 'Gemma 4 26B A4B', totalB: 26, activeB: 4, kvMB: 0.12, maxContext: 131072, quality: 71, vision: true, quants: ['Q4_K_M', 'Q6_K', 'Q8_0'], why: 'Capable and fast (4B active), and it can see images.' },
  { key: 'qwen/qwen3-32b', name: 'Qwen3 32B', totalB: 32.8, activeB: 32.8, kvMB: 0.26, maxContext: 40960, quality: 73, quants: ['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0'], why: 'The strongest dense model that fits a 24 GB GPU.' },
  { key: 'openai/gpt-oss-120b', name: 'gpt-oss 120B', totalB: 117, activeB: 5.1, kvMB: 0.07, maxContext: 131072, quality: 82, fixedGb: 65, quants: ['MXFP4'], why: 'Near-frontier reasoning; mixture of experts keeps it responsive.' },
  { key: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B A22B', totalB: 235, activeB: 22, kvMB: 0.19, maxContext: 131072, quality: 86, quants: ['Q3_K_M', 'Q4_K_M'], why: 'The most capable open model for big-memory workstations.' },
];

export interface LoadSettings { context_length: number; flash_attention?: boolean; offload_kv_cache_to_gpu?: boolean; eval_batch_size?: number; gpu?: number }
export interface Option {
  key: string; name: string; quant: Quant; variant: string; format: 'gguf' | 'mlx';
  context: number; weightsGb: number; kvGb: number; memoryGb: number; downloadGb: number;
  placement: 'gpu' | 'split' | 'cpu'; gpuShare: number;
  tps: number; promptTps: number; turnSeconds: number;
  quality: number; score: number; meets: boolean;
  load: LoadSettings; reasons: string[]; why: string; vision?: boolean; installed?: boolean;
}

const EFF: Record<Backend, number> = { cuda: 0.72, metal: 0.66, rocm: 0.6, vulkan: 0.5, cpu: 0.55 };
const PROMPT_K: Record<Backend, number> = { cuda: 70, rocm: 40, vulkan: 25, metal: 15, cpu: 0 };

/** Per-token cost on the CPU path: physical cores × vector width. */
function cpuPromptTps(hw: Hardware, activeB: number) {
  const per = hw.cpu.avx512 ? 9 : hw.cpu.avx2 || hw.cpu.neon ? 5 : 2;
  return Math.max(2, (hw.cpu.physicalCores * per * (hw.cpu.amx ? 2 : 1) * 8) / activeB);
}

export interface Calibration { [backend: string]: number }

/** Evaluate one configuration. Returns null when it doesn't fit at all. */
export function evaluate(spec: ModelSpec, quant: Quant, context: number, hw: Hardware, pref: Preference, cal: Calibration = {}): Option | null {
  const mlx = hw.backend === 'metal' && quant !== 'MXFP4';
  const bits = (mlx ? MLX_BITS[quant] : BITS[quant]) ?? BITS[quant];
  if (mlx && !MLX_BITS[quant]) return null;
  const weightsGb = spec.fixedGb ?? spec.totalB * bits / 8 * 1.02 + 0.2;
  const activeGb = spec.fixedGb ? spec.fixedGb * spec.activeB / spec.totalB : spec.activeB * bits / 8 * 1.02;
  const kvGb = spec.kvMB * context / 1024;
  const overhead = 0.6 + spec.totalB * 0.004;
  const discrete = hw.backend !== 'cpu' && hw.backend !== 'metal';
  let placement: Option['placement'], share = 1, kvOnGpu = true;
  if (weightsGb + kvGb + overhead <= hw.fastGb) placement = hw.backend === 'cpu' ? 'cpu' : 'gpu';
  // Splitting into system RAM must leave the machine breathing room.
  else if (discrete && weightsGb + kvGb + overhead <= hw.maxGb * 0.9) {
    placement = 'split';
    share = (hw.fastGb - kvGb - overhead) / weightsGb;
    const shareKvInRam = (hw.fastGb - overhead) / weightsGb;
    if (share < 0.85) { share = shareKvInRam; kvOnGpu = false; }
    share = Math.max(0, Math.min(0.98, share));
    if (share < 0.1) { placement = 'cpu'; share = 0; }
  } else if (hw.backend === 'cpu' && weightsGb + kvGb + overhead <= hw.maxGb) placement = 'cpu';
  else return null;

  const k = cal[hw.backend] ?? 1;
  const cpuEff = hw.cpu.avx2 || hw.cpu.neon ? EFF.cpu : 0.25;
  const fastEff = hw.backend === 'cpu' ? cpuEff : EFF[hw.backend];
  const tGpu = placement === 'cpu' ? 0 : (activeGb * share) / (hw.bandwidth.fast * fastEff);
  const tRam = placement === 'gpu' ? 0 : (activeGb * (placement === 'cpu' ? 1 : 1 - share)) / (hw.bandwidth.ram * cpuEff);
  // Attention reads the KV cache every token (about a third full in a typical agent run), plus fixed per-token work.
  const kvBw = placement !== 'cpu' && kvOnGpu ? hw.bandwidth.fast * fastEff : hw.bandwidth.ram * cpuEff;
  const tKv = (kvGb * 0.33) / kvBw;
  const tps = Math.min(300, k / (tGpu + tRam + tKv + 0.003));
  const gpuPrompt = PROMPT_K[hw.backend] ? hw.bandwidth.fast * PROMPT_K[hw.backend] / spec.activeB : 0;
  const cpuPrompt = cpuPromptTps(hw, spec.activeB);
  const promptTps = placement === 'gpu' ? gpuPrompt : placement === 'cpu' ? cpuPrompt : 1 / (share / gpuPrompt + (1 - share) / (cpuPrompt * 3)); // split: the GPU still does most prompt math
  const turnSeconds = 1500 / promptTps + 250 / tps;
  const t = TARGETS[pref];
  const meets = tps >= t.tps && turnSeconds <= t.turn;
  const ctxBonus = context >= 65536 ? 3 : context >= 32768 ? 2 : context >= 16384 ? 0 : -6;
  const quality = spec.quality - QUANT_COST[quant];
  // A little credit for speed beyond the target, so a point of quality never costs a 10× slowdown.
  const speedBonus = Math.max(-6, Math.min(4, 2.5 * Math.log2(tps / t.tps)));
  const score = quality + ctxBonus + speedBonus;
  const reasons: string[] = [];
  reasons.push(placement === 'gpu' ? (hw.backend === 'metal' ? 'Fits entirely in unified memory' : hw.backend === 'cpu' ? 'Fits in memory' : 'Fits entirely on the GPU')
    : placement === 'split' ? `${Math.round(share * 100)}% on the GPU, the rest in system RAM` : 'Runs on the CPU');
  if (spec.activeB < spec.totalB) reasons.push(`Mixture of experts: reads only ${spec.activeB}B of ${spec.totalB}B parameters per token`);
  reasons.push(`${Math.round(context / 1024)}k context with room to spare`);
  if (quant !== 'Q4_K_M' && quant !== 'MXFP4') reasons.push(`${mlx ? MLX_NAME[quant] : quant} keeps more precision than the usual 4-bit`);
  const batch = placement === 'cpu' ? 512 : hw.fastGb >= 22 ? 2048 : hw.fastGb >= 14 ? 1024 : 512;
  return {
    key: spec.key, name: spec.name, quant, variant: mlx ? MLX_NAME[quant]! : quant, format: mlx ? 'mlx' : 'gguf',
    context, weightsGb: r1(weightsGb), kvGb: r1(kvGb), memoryGb: r1(weightsGb + kvGb + overhead), downloadGb: r1(weightsGb),
    placement, gpuShare: r2(share), tps: r1(tps), promptTps: Math.round(promptTps), turnSeconds: r1(turnSeconds),
    quality: r1(quality), score: r1(score), meets,
    load: {
      context_length: context,
      flash_attention: hw.backend !== 'cpu' ? true : undefined,
      offload_kv_cache_to_gpu: placement === 'cpu' ? false : kvOnGpu,
      eval_batch_size: batch,
      ...(placement === 'split' ? { gpu: r2(share) } : placement === 'cpu' && discrete ? { gpu: 0 } : {}),
    },
    reasons, why: spec.why, vision: spec.vision,
  };
}
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

const contextsFor = (pref: Preference, max: number) => [65536, 32768, 16384, 8192].filter((c) => c <= max && (pref !== 'fast' || c <= 32768));

/** The best configuration of one model for this machine (null if it can't run). */
export function bestOf(spec: ModelSpec, hw: Hardware, pref: Preference, cal?: Calibration): Option | null {
  const opts: Option[] = [];
  for (const q of spec.quants) for (const c of contextsFor(pref, spec.maxContext)) { const o = evaluate(spec, q, c, hw, pref, cal); if (o) opts.push(o); }
  if (!opts.length) return null;
  // Agents need room: 8k context only when nothing larger meets the target.
  const meeting = opts.filter((o) => o.meets && o.context >= 16384).length ? opts.filter((o) => o.meets && o.context >= 16384) : opts.filter((o) => o.meets);
  if (meeting.length) return meeting.sort((a, b) => b.score - a.score || b.tps - a.tps)[0];
  // Nothing meets the target: the most responsive configuration with a usable context.
  return opts.filter((o) => o.context >= 16384).sort((a, b) => b.tps - a.tps)[0] ?? opts.sort((a, b) => b.tps - a.tps)[0];
}

export interface Plan { pref: Preference; target: typeof TARGETS[Preference]; best: Option | null; alternatives: Option[]; belowTarget: boolean; faster?: Option; smarter?: Option }

/** Plan downloads: the best catalog model for this machine and preference, plus alternatives. */
export function planDownloads(hw: Hardware, pref: Preference = 'balanced', cal?: Calibration): Plan {
  const all = CATALOG.map((s) => bestOf(s, hw, pref, cal)).filter(Boolean) as Option[];
  const met = all.filter((o) => o.meets);
  const roomy = met.filter((o) => o.context >= 16384);
  const meeting = (roomy.length ? roomy : met).sort((a, b) => b.score - a.score || b.tps - a.tps);
  const usable = all.filter((o) => o.quality >= 45);
  const best = meeting[0] ?? usable.sort((a, b) => b.tps - a.tps)[0] ?? all.sort((a, b) => b.tps - a.tps)[0] ?? null;
  const others = (meeting.length ? meeting : usable).filter((o) => o !== best);
  const faster = all.filter((o) => best && o.tps > best.tps * 1.4 && o.quality >= 45).sort((a, b) => b.score - a.score)[0];
  const smarter = all.filter((o) => best && o.score > best.score + 3 && o.tps >= 4).sort((a, b) => b.tps - a.tps)[0];
  const alternatives = [...new Map([...others.slice(0, 2), ...(faster ? [faster] : []), ...(smarter ? [smarter] : [])].map((o) => [o.key, o])).values()].filter((o) => o.key !== best?.key).slice(0, 3);
  return { pref, target: TARGETS[pref], best, alternatives, belowTarget: !!best && !best.meets, faster, smarter };
}

// ─── models already on the server ────────────────────────────────────────────

const TOOL_FAMILIES = /qwen3|qwen2\.5|gpt-oss|llama-?3\.[1-3]|llama-?4|mistral-(small|nemo|large|medium)|devstral|magistral|ministral|gemma-?[34]|granite-?[34]|glm-?4|hermes|command-r|phi-?4|deepseek-(v3|r1)|kimi|nemotron|functionary|xlam/i;

export function paramsB(m: Pick<LocalModel, 'id' | 'params'>): { total?: number; active?: number } {
  const src = `${m.params ?? ''} ${m.id}`.toLowerCase();
  const total = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/.exec(src)?.[1];
  const active = /a(\d+(?:\.\d+)?)b(?![a-z])/.exec(src)?.[1];
  return { total: total ? Number(total) : undefined, active: active ? Number(active) : undefined };
}

const quantOf = (q?: string): Quant => {
  const s = (q ?? '').toUpperCase();
  return /Q8|8BIT|F16|BF16/.test(s) ? 'Q8_0' : /Q6|6BIT/.test(s) ? 'Q6_K' : /Q5/.test(s) ? 'Q5_K_M' : /Q3|3BIT|Q2/.test(s) ? 'Q3_K_M' : /MXFP4/.test(s) ? 'MXFP4' : 'Q4_K_M';
};

/** A spec for a downloaded model: the catalog's when it matches, else estimated from its size and parameters. */
export function specFor(m: LocalModel): ModelSpec | null {
  const known = CATALOG.find((c) => c.key === m.id || m.id.toLowerCase().includes(c.key.split('/')[1]));
  const { total, active } = paramsB(m);
  const totalB = known?.totalB ?? total ?? (m.sizeBytes ? m.sizeBytes / 1e9 / (BITS[quantOf(m.quantization)] / 8) : undefined);
  if (!totalB) return null;
  const activeB = known?.activeB ?? active ?? totalB;
  const effective = activeB < totalB ? Math.sqrt(totalB * activeB) * 1.6 : totalB;
  return {
    key: m.id, name: m.displayName ?? m.id, totalB, activeB,
    kvMB: known?.kvMB ?? 0.05 * Math.pow(totalB, 0.45),
    maxContext: m.contextLength ?? known?.maxContext ?? 32768,
    quality: known?.quality ?? Math.min(88, 28 + 9.5 * Math.log2(effective)),
    fixedGb: m.sizeBytes ? m.sizeBytes / 1e9 : known?.fixedGb, vision: m.vision ?? known?.vision,
    quants: [quantOf(m.quantization)], why: known?.why ?? '',
  };
}

export interface Ranked extends Partial<Option> {
  id: string; tools: 'yes' | 'likely' | 'no'; fits: 'fast' | 'slow' | 'no' | 'unknown';
  gb?: number; context?: number; loaded: boolean; reasons: string[]; vision?: boolean;
}

/** Rank downloaded models for agents on this machine (hardware unknown → by size and capability only). */
export function rankInstalled(models: LocalModel[], hw: Hardware | null, pref: Preference = 'balanced', cal?: Calibration): Ranked[] {
  const out: Ranked[] = [];
  for (const m of models) {
    if (m.type === 'embeddings' || /embed/i.test(m.id)) continue;
    const tools: Ranked['tools'] = m.tools === true ? 'yes' : TOOL_FAMILIES.test(m.id) ? 'likely' : 'no';
    const spec = specFor(m);
    const loaded = m.state === 'loaded';
    const opt = spec && hw ? bestOf(spec, hw, pref, cal) : null;
    const reasons: string[] = [tools === 'yes' ? 'trained for tool use' : tools === 'likely' ? 'a family that calls tools' : 'not known to call tools — text tasks only'];
    let fits: Ranked['fits'] = 'unknown';
    if (hw && spec) {
      if (opt) { fits = opt.placement === 'split' || (opt.placement === 'cpu' && hw.backend !== 'cpu') ? 'slow' : 'fast'; reasons.push(...opt.reasons.slice(0, 2), `about ${Math.round(opt.tps)} tokens/s here`); }
      else if (loaded) { fits = 'slow'; reasons.push('larger than expected, but it’s loaded and running'); }
      else { fits = 'no'; reasons.push(`needs more memory than this machine has`); }
    }
    if (loaded) reasons.push('already loaded');
    const base = opt?.score ?? spec?.quality ?? 40;
    const score = (tools === 'no' ? -50 : tools === 'likely' ? -3 : 0) + base + (fits === 'no' ? -100 : 0) + (opt && !opt.meets ? -12 : 0) + (loaded ? 2 : 0);
    out.push({ ...(opt ?? {}), id: m.id, score: r1(score), tools, fits, gb: spec ? r1(spec.fixedGb ?? spec.totalB * BITS[spec.quants[0]] / 8) : undefined, context: m.contextLength, loaded, reasons, vision: m.vision });
  }
  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
