/**
 * Hardware profile for running models locally. What matters for an LLM is
 * where the weights live and how fast that memory is read: decode speed is
 * roughly memory bandwidth ÷ bytes read per token, and prompt processing is
 * bound by compute. So this finds every GPU (NVIDIA via nvidia-smi, AMD and
 * Intel via sysfs/lspci on Linux and the registry on Windows, Apple silicon
 * via sysctl/system_profiler) with its memory and an estimated bandwidth, the
 * CPU's physical cores and vector extensions (AVX2, AVX-512, AMX, NEON), and
 * system RAM with its type and speed where the OS says.
 *
 * Every probe is optional and time-boxed; parsing is split from I/O so it can
 * be tested with captured output. AUDA_FAKE_HW (JSON) replaces detection in
 * tests; AUDA_FAKE_GPU ("Name:GB") adds one NVIDIA GPU.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

export type Backend = 'cuda' | 'metal' | 'rocm' | 'vulkan' | 'cpu';
export interface Gpu {
  vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';
  name: string; vramGb: number; freeGb?: number;
  /** Memory bandwidth in GB/s (from a table of known parts, else estimated). */
  bandwidthGBs: number;
  backend: Backend; integrated?: boolean; computeCap?: string; cores?: number;
}
export interface Cpu {
  model: string; vendor: string; arch: string;
  physicalCores: number; threads: number; performanceCores?: number;
  avx2: boolean; avx512: boolean; amx: boolean; neon: boolean;
}
export interface Ram { totalGb: number; freeGb: number; kind?: string; speedMTs?: number; channels?: number; bandwidthGBs: number }
export interface Hardware {
  platform: string; arch: string;
  cpu: Cpu; ram: Ram; gpus: Gpu[];
  /** Apple silicon: CPU and GPU share one fast memory pool. */
  unified: boolean;
  /** Where models run fastest. */
  backend: Backend;
  /** Memory a model can use and still run at full speed (GPU/unified), in GB. */
  fastGb: number;
  /** Memory a model can use at all, spilling to system RAM (slower), in GB. */
  maxGb: number;
  /** Bandwidth of the fast pool and of system RAM, GB/s. */
  bandwidth: { fast: number; ram: number };
  tier: 'entry' | 'mid' | 'high' | 'workstation';
  summary: string;
  notes: string[];
  /** Stable fingerprint: changes when a GPU or RAM is added or removed. */
  fingerprint: string;
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const run = (bin: string, args: string[], timeout = 3000) => new Promise<string | null>((resolve) => {
  execFile(bin, args, { timeout, maxBuffer: 8 << 20, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
});
const read = (p: string) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };

// ─── bandwidth tables (GB/s) ─────────────────────────────────────────────────

const NVIDIA_BW: [RegExp, number][] = [
  [/RTX PRO 6000/i, 1792], [/5090/, 1792], [/5080/, 960], [/5070 Ti/i, 896], [/5070/, 672], [/5060 Ti/i, 448], [/5060/, 448],
  [/4090/, 1008], [/4080 SUPER/i, 736], [/4080/, 717], [/4070 Ti SUPER/i, 672], [/4070 Ti/i, 504], [/4070 SUPER/i, 504], [/4070/, 504], [/4060 Ti/i, 288], [/4060/, 272],
  [/3090 Ti/i, 1008], [/3090/, 936], [/3080 Ti/i, 912], [/3080/, 760], [/3070 Ti/i, 608], [/3070/, 448], [/3060 Ti/i, 448], [/3060/, 360], [/3050/, 224],
  [/2080 Ti/i, 616], [/2080/, 448], [/2070/, 448], [/2060/, 336], [/1080 Ti/i, 484], [/1080/, 320], [/1070/, 256], [/1660/, 192],
  [/H200/, 4800], [/H100/, 3350], [/GH200/, 4000], [/A100.*80/i, 2039], [/A100/, 1555], [/L40S/, 864], [/L40/, 864], [/\bL4\b/, 300],
  [/RTX 6000 Ada/i, 960], [/A6000/, 768], [/A5000/, 768], [/A4000/, 448], [/\bA10\b/, 600], [/V100/, 900], [/T4/, 320], [/P40/, 347], [/P100/, 732],
];
const AMD_BW: [RegExp, number][] = [
  [/MI300X/i, 5300], [/MI300A/i, 5300], [/MI250/i, 3200], [/MI210/i, 1600], [/W7900/i, 864], [/W7800/i, 576],
  [/9070 XT/i, 640], [/9070/, 640], [/9060 XT/i, 320], [/7900 XTX/i, 960], [/7900 XT/i, 800], [/7900 GRE/i, 576], [/7800 XT/i, 624], [/7700 XT/i, 432], [/7600 XT/i, 288], [/7600/, 288],
  [/6950 XT/i, 576], [/6900 XT/i, 512], [/6800 XT/i, 512], [/6800/, 512], [/6750 XT/i, 432], [/6700 XT/i, 384], [/6650 XT/i, 280], [/6600/, 224],
  [/Radeon 8060S|Strix Halo|Ryzen AI Max/i, 256], [/Radeon VII/i, 1024],
];
const INTEL_BW: [RegExp, number, number][] = [ // name, bandwidth, VRAM GB
  [/B580/i, 456, 12], [/B570/i, 380, 10], [/A770/i, 560, 16], [/A750/i, 512, 8], [/A580/i, 512, 8], [/A380/i, 186, 6], [/A310/i, 124, 4],
];
const APPLE_BW: [RegExp, number][] = [
  [/M4 Max/i, 546], [/M4 Pro/i, 273], [/M4\b/i, 120], [/M5/i, 153],
  [/M3 Ultra/i, 819], [/M3 Max/i, 400], [/M3 Pro/i, 150], [/M3\b/i, 100],
  [/M2 Ultra/i, 800], [/M2 Max/i, 400], [/M2 Pro/i, 200], [/M2\b/i, 100],
  [/M1 Ultra/i, 800], [/M1 Max/i, 400], [/M1 Pro/i, 200], [/M1\b/i, 68],
];
const lookup = (table: [RegExp, number, ...number[]][], name: string) => table.find(([re]) => re.test(name));

/** Bandwidth for a discrete GPU: the table, else roughly 25 GB/s per GB of VRAM (laptop parts run lower). */
export function gpuBandwidth(vendor: Gpu['vendor'], name: string, vramGb: number): number {
  const hit = vendor === 'nvidia' ? lookup(NVIDIA_BW, name) : vendor === 'amd' ? lookup(AMD_BW, name) : vendor === 'intel' ? lookup(INTEL_BW, name) : vendor === 'apple' ? lookup(APPLE_BW, name) : undefined;
  let bw = hit ? hit[1] : Math.max(150, Math.min(1000, vramGb * 25));
  if (/laptop|mobile|max-q/i.test(name) && vendor !== 'apple') bw *= 0.65;
  return Math.round(bw);
}

// ─── parsers (pure) ──────────────────────────────────────────────────────────

/** `nvidia-smi --query-gpu=name,memory.total,memory.free,compute_cap --format=csv,noheader,nounits` */
export function parseNvidiaSmi(out: string): Gpu[] {
  const gpus: Gpu[] = [];
  for (const line of out.trim().split('\n')) {
    const [name, total, free, cap] = line.split(',').map((s) => s.trim());
    if (!name || !Number(total)) continue;
    const vramGb = round(Number(total) / 1024);
    gpus.push({ vendor: 'nvidia', name, vramGb, freeGb: Number(free) ? round(Number(free) / 1024) : undefined, computeCap: cap && /^\d/.test(cap) ? cap : undefined, backend: 'cuda', bandwidthGBs: gpuBandwidth('nvidia', name, vramGb) });
  }
  return gpus;
}

/** /proc/cpuinfo (x86 or ARM) */
export function parseCpuinfo(text: string): Partial<Cpu> {
  const model = /^model name\s*:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? /^Hardware\s*:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const flags = ` ${(/^(?:flags|Features)\s*:\s*(.+)$/m.exec(text)?.[1] ?? '').toLowerCase()} `;
  const cores = new Set<string>();
  let phys = '0';
  for (const line of text.split('\n')) {
    const p = /^physical id\s*:\s*(\d+)/.exec(line); if (p) phys = p[1];
    const c = /^core id\s*:\s*(\d+)/.exec(line); if (c) cores.add(`${phys}:${c[1]}`);
  }
  const threads = (text.match(/^processor\s*:/gm) ?? []).length;
  return {
    model, vendor: /^vendor_id\s*:\s*(.+)$/m.exec(text)?.[1]?.trim(),
    physicalCores: cores.size || undefined, threads: threads || undefined,
    avx2: flags.includes(' avx2 '), avx512: flags.includes(' avx512f '), amx: flags.includes(' amx_tile '), neon: flags.includes(' asimd ') || flags.includes(' neon '),
  };
}

/** `dmidecode -t memory` → type, configured speed, populated modules. */
export function parseDmidecode(text: string): { kind?: string; speedMTs?: number; modules: number } {
  const devices = text.split(/\n(?=Memory Device)/).filter((d) => /^Memory Device/.test(d) && !/Size:\s*No Module Installed/i.test(d));
  const kind = devices.map((d) => /^\s*Type:\s*(DDR\d|LPDDR\d\w?)/m.exec(d)?.[1]).find(Boolean);
  const speeds = devices.map((d) => Number(/Configured (?:Memory|Clock) Speed:\s*(\d+)/i.exec(d)?.[1] ?? /^\s*Speed:\s*(\d+)/m.exec(d)?.[1])).filter((n) => n > 0);
  return { kind, speedMTs: speeds.length ? Math.min(...speeds) : undefined, modules: devices.length };
}

/** RAM bandwidth: channels × MT/s × 8 bytes, else a sensible default for the class of machine. */
export function ramBandwidth(o: { kind?: string; speedMTs?: number; modules?: number; threads: number; platform: string }): { bandwidthGBs: number; channels?: number } {
  if (o.speedMTs && o.modules) {
    const server = o.threads >= 48;
    const channels = server ? Math.min(o.modules, 12) : Math.min(Math.max(o.modules, 1), 2); // desktops: dual channel however many DIMMs
    return { bandwidthGBs: Math.round(channels * o.speedMTs * 8 / 1000 * 0.85), channels };
  }
  if (o.threads >= 64) return { bandwidthGBs: 200 };
  if (o.threads >= 32) return { bandwidthGBs: 90 };
  if (o.kind?.startsWith('LPDDR5')) return { bandwidthGBs: 100 };
  return { bandwidthGBs: o.threads >= 16 ? 60 : 45 };
}

/** Windows display-adapter registry entries (DriverDesc + qwMemorySize) as JSON from PowerShell. */
export function parseWindowsAdapters(json: string): Gpu[] {
  let rows: any[] = [];
  try { const j = JSON.parse(json); rows = Array.isArray(j) ? j : [j]; } catch { return []; }
  const out: Gpu[] = [];
  for (const r of rows) {
    const name = String(r.DriverDesc ?? '');
    const vramGb = round(Number(r['HardwareInformation.qwMemorySize'] ?? 0) / 1024 ** 3);
    if (!name || /nvidia/i.test(name) || /basic display|remote|virtual|parsec|idd/i.test(name)) continue; // NVIDIA comes from nvidia-smi
    const vendor = /amd|radeon/i.test(name) ? 'amd' : /intel/i.test(name) ? 'intel' : 'other';
    const integrated = vendor === 'intel' ? !/arc/i.test(name) : vendor === 'amd' ? vramGb < 2 && !/RX|PRO W|Instinct/i.test(name) : vramGb < 2;
    const intel = vendor === 'intel' ? lookup(INTEL_BW, name) : undefined;
    out.push({ vendor, name, vramGb: intel?.[2] ?? vramGb, integrated, backend: 'vulkan', bandwidthGBs: gpuBandwidth(vendor, name, intel?.[2] ?? vramGb) });
  }
  return out;
}

// ─── probes ──────────────────────────────────────────────────────────────────

async function nvidia(): Promise<Gpu[]> {
  if (process.env.AUDA_FAKE_GPU) {
    const [name, vram] = process.env.AUDA_FAKE_GPU.split(':');
    return [{ vendor: 'nvidia', name, vramGb: Number(vram), backend: 'cuda', bandwidthGBs: gpuBandwidth('nvidia', name, Number(vram)) }];
  }
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.free,compute_cap', '--format=csv,noheader,nounits'])
    ?? await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits']);
  return out ? parseNvidiaSmi(out) : [];
}

/** AMD and Intel discrete GPUs on Linux, from sysfs (amdgpu reports VRAM; Intel Arc from a table). */
async function linuxOtherGpus(): Promise<Gpu[]> {
  if (process.platform !== 'linux') return [];
  const out: Gpu[] = [];
  let lspci: string | null | undefined;
  const nameOf = async (slot: string) => {
    lspci ??= await run('lspci', ['-mm'], 2000);
    const line = lspci?.split('\n').find((l) => l.startsWith(slot.replace(/^0000:/, '')));
    return line ? line.split('"').filter((_, i) => i % 2 === 1).slice(1, 3).join(' ').replace(/\[|\]/g, '') : null;
  };
  let cards: string[] = [];
  try { cards = fs.readdirSync('/sys/class/drm').filter((d) => /^card\d+$/.test(d)); } catch { return []; }
  for (const card of cards) {
    const dev = `/sys/class/drm/${card}/device`;
    const vendorId = read(`${dev}/vendor`);
    const slot = (read(`${dev}/uevent`) ?? '').match(/PCI_SLOT_NAME=(\S+)/)?.[1] ?? '';
    if (vendorId === '0x1002') {
      const vram = Number(read(`${dev}/mem_info_vram_total`) ?? 0) / 1024 ** 3;
      const name = read(`${dev}/product_name`) || await nameOf(slot) || 'AMD Radeon';
      const integrated = vram < 2;
      const rocm = fs.existsSync('/opt/rocm') || fs.existsSync('/dev/kfd');
      out.push({ vendor: 'amd', name, vramGb: round(vram), integrated, backend: rocm ? 'rocm' : 'vulkan', bandwidthGBs: gpuBandwidth('amd', name, vram) });
    } else if (vendorId === '0x8086') {
      const name = await nameOf(slot) ?? 'Intel Graphics';
      const intel = lookup(INTEL_BW, name);
      if (intel || /arc/i.test(name)) out.push({ vendor: 'intel', name, vramGb: intel?.[2] ?? 8, backend: 'vulkan', bandwidthGBs: gpuBandwidth('intel', name, intel?.[2] ?? 8) });
    }
  }
  return out;
}

async function windowsOtherGpus(): Promise<Gpu[]> {
  if (process.platform !== 'win32') return [];
  const ps = "Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | Select-Object DriverDesc,'HardwareInformation.qwMemorySize' | ConvertTo-Json -Compress";
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 6000);
  return out ? parseWindowsAdapters(out) : [];
}

async function apple(totalGb: number): Promise<{ gpu: Gpu; cpuName: string; pCores?: number } | null> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return null;
  const brand = (await run('sysctl', ['-n', 'machdep.cpu.brand_string']))?.trim() || 'Apple silicon';
  const pCores = Number((await run('sysctl', ['-n', 'hw.perflevel0.physicalcpu']))?.trim()) || undefined;
  // macOS lets the GPU wire about 2/3 of RAM (3/4 above 36 GB) unless iogpu.wired_limit_mb is raised.
  const wired = Number((await run('sysctl', ['-n', 'iogpu.wired_limit_mb']))?.trim()) || 0;
  const vram = wired > 0 ? wired / 1024 : totalGb * (totalGb > 36 ? 0.75 : 0.67);
  let cores: number | undefined;
  const sp = await run('system_profiler', ['SPDisplaysDataType', '-json'], 8000);
  try { cores = Number(JSON.parse(sp ?? '{}').SPDisplaysDataType?.[0]?.sppci_cores) || undefined; } catch { /* older macOS */ }
  let bw = gpuBandwidth('apple', brand, vram);
  if (/M3 Max/i.test(brand) && cores && cores <= 30) bw = 300;   // binned parts have a narrower bus
  if (/M4 Max/i.test(brand) && cores && cores <= 32) bw = 410;
  return { gpu: { vendor: 'apple', name: `${brand}${cores ? ` (${cores}-core GPU)` : ''}`, vramGb: round(vram), backend: 'metal', bandwidthGBs: bw, cores }, cpuName: brand, pCores };
}

async function cpuInfo(): Promise<Cpu> {
  const cpus = os.cpus();
  const base: Cpu = { model: cpus[0]?.model?.replace(/\s+/g, ' ').trim() || os.arch(), vendor: '', arch: process.arch, physicalCores: Math.max(1, Math.round(cpus.length / 2)), threads: cpus.length || 1, avx2: false, avx512: false, amx: false, neon: process.arch === 'arm64' };
  if (process.platform === 'linux') {
    const p = parseCpuinfo(read('/proc/cpuinfo') ?? '');
    return { ...base, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)), model: p.model ?? base.model } as Cpu;
  }
  if (process.platform === 'darwin') {
    const phys = Number((await run('sysctl', ['-n', 'hw.physicalcpu']))?.trim()) || base.physicalCores;
    const avx2 = (await run('sysctl', ['-n', 'hw.optional.avx2_0']))?.trim() === '1';
    const avx512 = (await run('sysctl', ['-n', 'hw.optional.avx512f']))?.trim() === '1';
    return { ...base, physicalCores: phys, avx2, avx512 };
  }
  // Windows: no flags without native calls; every x64 CPU from the last decade has AVX2.
  return { ...base, avx2: process.arch === 'x64' };
}

// ─── profile ─────────────────────────────────────────────────────────────────

/** Combine probes into a profile with memory budgets and a one-line summary. */
export function profile(o: { platform: string; arch: string; cpu: Cpu; ram: Ram; gpus: Gpu[]; unified: boolean }): Hardware {
  const { cpu, ram, unified } = o;
  const discrete = o.gpus.filter((g) => !g.integrated && g.vendor !== 'apple' && g.vramGb >= 3);
  const appleGpu = o.gpus.find((g) => g.vendor === 'apple');
  const vram = discrete.reduce((s, g) => s + g.vramGb, 0);
  const notes: string[] = [];
  let backend: Backend = 'cpu', fastGb: number, maxGb: number, fastBw: number;
  const ramUsable = Math.max(1, ram.totalGb * 0.8 - 2);   // leave room for the OS, AUDA and its browser
  if (unified && appleGpu) {
    backend = 'metal'; fastGb = appleGpu.vramGb - 1.5; maxGb = fastGb; fastBw = appleGpu.bandwidthGBs;
  } else if (discrete.length) {
    backend = discrete[0].backend;
    fastGb = vram * 0.92 - 0.5 * discrete.length;          // driver/context overhead per card
    maxGb = fastGb + ramUsable;
    // Several cards split layers; the slowest card sets the pace.
    fastBw = Math.min(...discrete.map((g) => g.bandwidthGBs));
    if (discrete.length > 1) notes.push(`${discrete.length} GPUs — models are split across them`);
    if (backend === 'vulkan') notes.push('Runs on Vulkan (no CUDA/ROCm found) — a little slower');
  } else {
    fastGb = Math.min(ramUsable, 14); maxGb = ramUsable; fastBw = ram.bandwidthGBs;
    notes.push('No GPU found — models run on the CPU, so smaller models feel much faster');
    if (!cpu.avx2 && cpu.arch === 'x64') notes.push('This CPU has no AVX2 — expect slow responses');
  }
  if (cpu.avx512) notes.push('AVX-512 speeds up prompt processing on the CPU');
  const tier = fastGb >= 60 ? 'workstation' : fastGb >= 20 ? 'high' : fastGb >= 10 ? 'mid' : 'entry';
  const gpuText = unified && appleGpu ? `${appleGpu.name} · ${ram.totalGb} GB unified memory`
    : discrete.length ? discrete.map((g) => `${g.name} ${g.vramGb} GB`).join(' + ') + ` · ${ram.totalGb} GB RAM`
    : `${cpu.physicalCores}-core CPU · ${ram.totalGb} GB RAM · no GPU`;
  const fingerprint = [o.platform, o.arch, Math.round(ram.totalGb), ...o.gpus.map((g) => `${g.vendor}:${g.name}:${Math.round(g.vramGb)}`)].join('|');
  return {
    platform: o.platform, arch: o.arch, cpu, ram, gpus: o.gpus, unified, backend,
    fastGb: round(Math.max(1, fastGb)), maxGb: round(Math.max(1, maxGb)),
    bandwidth: { fast: Math.round(fastBw), ram: ram.bandwidthGBs }, tier, summary: gpuText, notes, fingerprint,
  };
}

let cache: { at: number; hw: Hardware } | null = null;
export async function detectHardware(force = false): Promise<Hardware> {
  if (!force && cache && Date.now() - cache.at < 10 * 60_000) return cache.hw;
  if (process.env.AUDA_FAKE_HW) {
    const f = JSON.parse(process.env.AUDA_FAKE_HW);
    const cpu: Cpu = { model: 'Test CPU', vendor: 'test', arch: 'x64', physicalCores: 8, threads: 16, avx2: true, avx512: false, amx: false, neon: false, ...f.cpu };
    const ram: Ram = { totalGb: 32, freeGb: 20, bandwidthGBs: 60, ...f.ram };
    const gpus: Gpu[] = (f.gpus ?? []).map((g: any) => ({ backend: g.vendor === 'apple' ? 'metal' : g.vendor === 'amd' ? 'rocm' : g.vendor === 'nvidia' ? 'cuda' : 'vulkan', bandwidthGBs: gpuBandwidth(g.vendor, g.name, g.vramGb), ...g }));
    cache = { at: Date.now(), hw: profile({ platform: f.platform ?? 'linux', arch: f.arch ?? 'x64', cpu, ram, gpus, unified: !!f.unified }) };
    return cache.hw;
  }
  const totalGb = round(os.totalmem() / 1e9), freeGb = round(os.freemem() / 1e9);
  const [cpu, nv, other, win, mac] = await Promise.all([cpuInfo(), nvidia(), linuxOtherGpus(), windowsOtherGpus(), apple(totalGb)]);
  let ramDetail: { kind?: string; speedMTs?: number; modules?: number } = {};
  if (process.platform === 'linux') { const d = await run('dmidecode', ['-t', 'memory'], 3000); if (d) ramDetail = parseDmidecode(d); }
  if (mac) ramDetail.kind = /M4|M5/.test(mac.cpuName) ? 'LPDDR5X' : 'LPDDR5';
  const bw = mac ? { bandwidthGBs: mac.gpu.bandwidthGBs } : ramBandwidth({ ...ramDetail, threads: cpu.threads, platform: process.platform });
  const ram: Ram = { totalGb, freeGb, kind: ramDetail.kind, speedMTs: ramDetail.speedMTs, channels: (bw as any).channels, bandwidthGBs: bw.bandwidthGBs };
  const gpus = [...nv, ...other, ...win, ...(mac ? [mac.gpu] : [])];
  const c = mac ? { ...cpu, model: mac.cpuName, performanceCores: mac.pCores } : cpu;
  cache = { at: Date.now(), hw: profile({ platform: process.platform, arch: process.arch, cpu: c, ram, gpus, unified: !!mac }) };
  return cache.hw;
}
