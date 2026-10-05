/**
 * Local model setup, as one guided flow: AUDA finds LM Studio (or explains how
 * to install it), recommends a model for this machine, downloads and loads it,
 * checks it can use tools, measures its speed and connects — with every step
 * visible as it happens. Used on Home at first run and in Connections.
 */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore } from '../lib/store';
import { api, post } from '../lib/api';
import { fm } from '../motion/spring';
import { Morph } from '../motion/Morph';
import { Button } from './controls';
import type { LocalHardware, LocalPreference, LocalRanked, LocalSetupState, LocalSuggestion } from '../lib/types';

interface Doctor {
  baseUrl: string | null; api: string | null; error: string | null; hardware: LocalHardware | null; lms: string | null; local: boolean;
  found: { baseUrl: string; flavor: string; models: number }[]; models: { id: string; type: string; state: string }[];
  ranked: LocalRanked[]; suggestions: LocalSuggestion[]; embedding: LocalSuggestion; hasEmbeddings: boolean; platform: string; preference: LocalPreference;
}

const bytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
const left = (iso?: string) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.parse(iso) - Date.now()) / 1000);
  return s < 60 ? 'less than a minute left' : `about ${Math.round(s / 60)} min left`;
};
const k = (n?: number) => n ? `${Math.round(n / 1024)}k` : '';

export function LocalSetup({ compact = false }: { compact?: boolean }) {
  const s = useStore();
  const m = s.settings?.models;
  const live = m?.localSetup ?? null;
  const [doc, setDoc] = useState<Doctor | null>(null);
  const [err, setErr] = useState('');
  const refresh = (pref?: LocalPreference) => api<Doctor>(`/api/lmstudio/doctor${pref ? `?preference=${pref}` : ''}`).then(setDoc).catch((e) => setErr((e as Error).message));
  const setPref = (p: LocalPreference) => { setDoc((d) => d ? { ...d, preference: p } : d); void post('/api/lmstudio/preference', { preference: p }).then(() => refresh(p)); };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (live && !live.running) void refresh(); }, [live?.finishedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = (body: Record<string, unknown> = {}) => { setErr(''); post('/api/lmstudio/setup', body).catch((e) => setErr((e as Error).message)); };

  const connected = !!m?.local?.baseUrl;
  const view = live?.running ? 'progress'
    : live?.outcome === 'failed' ? 'failed'
    : connected ? 'ready'
    : live?.outcome === 'needs-model' || live?.outcome === 'text-only' ? 'pick'
    : live?.outcome === 'no-server' || (doc && !doc.baseUrl && !doc.lms) ? 'install'
    : doc ? 'intro' : 'looking';

  return (
    <div className={`lsu ${compact ? 'compact' : ''}`}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={view} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={fm.glide}>
          {view === 'looking' && <div className="row small muted"><Morph shape="orbit" size={16} /> Looking for LM Studio on this machine and your network…</div>}
          {view === 'intro' && doc && <Intro doc={doc} compact={compact} onPref={setPref} onStart={() => start()} />}
          {view === 'progress' && live && <Progress live={live} />}
          {view === 'pick' && live && <Pick live={live} doc={doc} compact={compact} onPref={setPref} onDownload={(key) => start({ download: key })} onUse={(id) => start({ model: id })} />}
          {view === 'install' && <Install doc={doc} compact={compact} hw={doc?.hardware ?? live?.hardware ?? null} suggestion={(doc?.suggestions ?? live?.suggestions)?.[0]} onCheck={() => start()} />}
          {view === 'failed' && live && (
            <div className="stack" style={{ gap: 10 }}>
              <Steps live={live} />
              <div className="lsu-note problem">{live.message}</div>
              <div className="row" style={{ gap: 8 }}><Button size="sm" variant="primary" icon="recover" onClick={() => start()}>Try again</Button></div>
            </div>
          )}
          {view === 'ready' && <Ready doc={doc} live={live} compact={compact} onPref={setPref} onUse={(id) => start({ model: id })} onDownload={(key) => start({ download: key })} onAgain={() => start()} />}
        </motion.div>
      </AnimatePresence>
      {err && <div className="lsu-note problem" style={{ marginTop: 10 }}>{err}</div>}
    </div>
  );
}

const BACKEND: Record<string, string> = { cuda: 'CUDA', metal: 'Metal', rocm: 'ROCm', vulkan: 'Vulkan', cpu: 'CPU' };
const PREFS: { value: LocalPreference; label: string; hint: string }[] = [
  { value: 'fast', label: 'Fastest', hint: 'Snappy replies; a lighter model' },
  { value: 'balanced', label: 'Balanced', hint: 'Smart and quick' },
  { value: 'smart', label: 'Smartest', hint: 'The most capable model that still feels usable' },
];

/** What AUDA found: GPUs (backend, memory, bandwidth), CPU (cores, vector extensions), RAM. */
function Machine({ hw, compact }: { hw: LocalHardware | null | undefined; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  if (!hw) return null;
  const gpus = hw.gpus.filter((g) => !g.integrated);
  const flags = [hw.cpu.avx512 && 'AVX-512', hw.cpu.avx2 && !hw.cpu.avx512 && 'AVX2', hw.cpu.amx && 'AMX', hw.cpu.neon && 'NEON'].filter(Boolean) as string[];
  return (
    <div className="lsu-machine">
      <button className="lsu-machine-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Morph shape={hw.backend === 'cpu' ? 'dots' : 'flow'} size={14} />
        <span className="grow ellipsis"><b>Your machine</b> · {hw.summary}</span>
        <span className="chip">{BACKEND[hw.backend]}</span>
        <Morph shape={open ? 'chevronDown' : 'chevronRight'} size={12} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="lsu-machine-body" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={fm.glide}>
            {gpus.map((g, i) => (
              <div key={i} className="lsu-hw-row">
                <span className="lsu-hw-k">{g.vendor === 'apple' ? 'GPU' : `GPU${gpus.length > 1 ? ` ${i + 1}` : ''}`}</span>
                <span className="grow">{g.name}</span>
                <span className="small faint tnum">{g.vendor === 'apple' ? `${g.vramGb} GB usable` : `${g.vramGb} GB`} · {g.bandwidthGBs} GB/s</span>
              </div>
            ))}
            <div className="lsu-hw-row">
              <span className="lsu-hw-k">CPU</span>
              <span className="grow ellipsis">{hw.cpu.model}</span>
              <span className="small faint tnum">{hw.cpu.physicalCores} cores{hw.cpu.threads !== hw.cpu.physicalCores ? ` · ${hw.cpu.threads} threads` : ''}</span>
            </div>
            {flags.length > 0 && <div className="lsu-hw-row"><span className="lsu-hw-k" /><span className="row wrap" style={{ gap: 4 }}>{flags.map((f) => <span key={f} className="chip">{f}</span>)}</span></div>}
            <div className="lsu-hw-row">
              <span className="lsu-hw-k">Memory</span>
              <span className="grow">{hw.ram.totalGb} GB{hw.ram.kind ? ` ${hw.ram.kind}` : ''}{hw.ram.speedMTs ? `-${hw.ram.speedMTs}` : ''}{hw.unified ? ' unified' : ''}</span>
              <span className="small faint tnum">~{hw.ram.bandwidthGBs} GB/s</span>
            </div>
            <div className="lsu-hw-row">
              <span className="lsu-hw-k">For models</span>
              <span className="grow">{hw.fastGb} GB at full speed{hw.maxGb > hw.fastGb + 1 ? ` · up to ${hw.maxGb} GB with system RAM` : ''}</span>
            </div>
            {hw.notes.length > 0 && <ul className="lsu-notes small muted">{hw.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PrefSwitch({ value, onChange }: { value: LocalPreference; onChange: (p: LocalPreference) => void }) {
  return (
    <div className="lsu-pref" role="radiogroup" aria-label="What matters more">
      {PREFS.map((p) => (
        <button key={p.value} role="radio" aria-checked={value === p.value} className={value === p.value ? 'on' : ''} title={p.hint} onClick={() => onChange(p.value)}>
          {value === p.value && <motion.span layoutId="lsu-pref-knob" className="lsu-pref-knob" transition={fm.snap} />}
          <span>{p.label}</span>
        </button>
      ))}
    </div>
  );
}

const where = (x: { placement?: string; gpuShare?: number }, hw?: LocalHardware | null) =>
  x.placement === 'gpu' ? (hw?.unified ? 'All in unified memory' : hw?.backend === 'cpu' ? 'In memory' : 'All on the GPU')
  : x.placement === 'split' ? `${Math.round((x.gpuShare ?? 0) * 100)}% GPU · rest in RAM` : x.placement === 'cpu' ? 'On the CPU' : '';

function SuggestionCard({ x, hw, onDownload }: { x: LocalSuggestion; hw?: LocalHardware | null; onDownload: (key: string) => void }) {
  return (
    <div className={`lsu-sug ${x.recommended ? 'rec' : ''}`}>
      <div className="row" style={{ gap: 6 }}>
        {x.recommended && <span className="chip accent lsu-rec">Best for this machine</span>}
        {x.label && <span className="chip lsu-rec">{x.label}</span>}
      </div>
      <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
        <b className="grow">{x.name}</b><span className="small faint tnum" style={{ whiteSpace: 'nowrap' }}>{x.gb} GB</span>
      </div>
      {x.tps !== undefined && (
        <div className="lsu-speed">
          <span className="lsu-tps tnum">~{Math.round(x.tps)}</span><span className="small muted">tokens/s</span>
          {x.turnSeconds !== undefined && <span className="small faint">· ~{x.turnSeconds < 10 ? x.turnSeconds.toFixed(1) : Math.round(x.turnSeconds)} s a step</span>}
        </div>
      )}
      <div className="row wrap" style={{ gap: 4 }}>
        {x.variant && <span className="chip" title="Quantization">{x.variant}</span>}
        {x.context && <span className="chip">{Math.round(x.context / 1024)}k context</span>}
        {x.placement && <span className={`chip ${x.placement === 'gpu' ? 'settled' : x.placement === 'split' ? '' : 'attention'}`}>{where(x, hw)}</span>}
      </div>
      <div className="small muted">{x.why}</div>
      {x.reasons && x.reasons.length > 1 && <ul className="lsu-why small faint">{x.reasons.slice(1, 3).map((r) => <li key={r}>{r}</li>)}</ul>}
      {x.meets === false && <div className="small" style={{ color: 'var(--attention)' }}>Slower than ideal — this machine’s limit for a model this capable.</div>}
      <div style={{ marginTop: 'auto' }}><Button size="sm" variant={x.recommended ? 'primary' : undefined} icon="arrowRight" onClick={() => onDownload(x.key)}>Download &amp; set up</Button></div>
    </div>
  );
}

function Intro({ doc, compact, onPref, onStart }: { doc: Doctor; compact: boolean; onPref: (p: LocalPreference) => void; onStart: () => void }) {
  const ready = doc.ranked.find((r) => r.tools !== 'no' && r.fits !== 'no');
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div>
        <div style={{ fontWeight: 600 }}>{doc.baseUrl ? `LM Studio is running at ${doc.baseUrl.replace(/^https?:\/\//, '')}` : 'LM Studio is installed on this machine'}</div>
        <div className="small muted">{doc.baseUrl
          ? ready ? `${ready.id} suits this machine${ready.tps ? ` (~${Math.round(ready.tps)} tokens/s)` : ''}. AUDA will load it with settings tuned to your hardware, check it can use tools, and connect.` : `No model there yet can run agents — AUDA will plan one for this machine.`
          : 'Its server isn’t running. AUDA will start it, then plan, load and connect a model.'}</div>
      </div>
      <Machine hw={doc.hardware} compact={compact} />
      {doc.hardware && <PrefSwitch value={doc.preference} onChange={onPref} />}
      <div className="row" style={{ gap: 8 }}><Button variant="primary" icon="play" onClick={onStart}>Set up for me</Button><span className="small faint">About a minute. Nothing leaves your network.</span></div>
    </div>
  );
}

function Steps({ live }: { live: LocalSetupState }) {
  return (
    <ol className="lsu-steps">
      {live.steps.map((st) => (
        <li key={st.id} className={`lsu-step ${st.state}`}>
          <span className="lsu-dot">{st.state === 'done' ? <Morph shape="check" size={12} /> : st.state === 'active' ? <Morph shape="orbit" size={12} /> : st.state === 'failed' ? <Morph shape="problem" size={12} /> : null}</span>
          <div className="grow"><div className="lsu-label">{st.label}</div>{st.detail && st.state !== 'pending' && <div className="small faint lsu-detail">{st.detail}</div>}</div>
        </li>
      ))}
    </ol>
  );
}

function Progress({ live }: { live: LocalSetupState }) {
  const d = live.download;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row"><Morph shape="flow" size={18} color="var(--accent)" /><b>{live.auto ? 'Setting up your local model' : 'Setting up'}…</b></div>
      <Steps live={live} />
      {d && d.pct < 100 && (
        <div className="lsu-dl">
          <div className="row small"><span className="mono ellipsis grow">{d.model}</span><span className="tnum">{d.pct.toFixed(0)}%</span></div>
          <div className="lsu-bar"><motion.div className="lsu-fill" initial={false} animate={{ width: `${Math.max(2, d.pct)}%` }} transition={fm.glide} /></div>
          <div className="small faint tnum">{d.totalBytes ? `${bytes(d.downloadedBytes)} of ${bytes(d.totalBytes)}` : 'Starting…'}{d.bytesPerSecond ? ` · ${bytes(d.bytesPerSecond)}/s` : ''}{d.eta ? ` · ${left(d.eta)}` : ''}</div>
        </div>
      )}
    </div>
  );
}

function Pick({ live, doc, compact, onPref, onDownload, onUse }: { live: LocalSetupState; doc: Doctor | null; compact: boolean; onPref: (p: LocalPreference) => void; onDownload: (key: string) => void; onUse: (id: string) => void }) {
  const others = (doc?.ranked ?? live.ranked ?? []).filter((r) => r.fits !== 'no' && r.id !== live.result?.model);
  const hw = doc?.hardware ?? live.hardware;
  const suggestions = doc?.suggestions ?? live.suggestions ?? [];
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div>
        <div style={{ fontWeight: 600 }}>{live.outcome === 'text-only' ? `Connected ${live.result?.model} for text tasks` : 'LM Studio is ready — it needs one model'}</div>
        <div className="small muted">{suggestions.length ? `Agents need a model that can use tools. Planned for ${hw ? 'your hardware' : 'a typical machine'}:` : 'This machine is too small for a model that can run agents. Connect Claude, or LM Studio on a bigger computer on your network.'}</div>
      </div>
      <Machine hw={hw} compact={compact} />
      {hw && <PrefSwitch value={doc?.preference ?? live.preference ?? 'balanced'} onChange={onPref} />}
      <div className="lsu-sugs">{suggestions.slice(0, compact ? 2 : 3).map((x) => <SuggestionCard key={x.key} x={x} hw={hw} onDownload={onDownload} />)}</div>
      {!compact && others.length > 0 && (
        <details className="lsu-more">
          <summary className="small">Or use a model that’s already there ({others.length})</summary>
          <ModelList ranked={others} onUse={onUse} />
        </details>
      )}
    </div>
  );
}

function ModelList({ ranked, current, onUse }: { ranked: LocalRanked[]; current?: string; onUse: (id: string) => void }) {
  return (
    <div className="lsu-models">
      {ranked.map((r) => (
        <div key={r.id} className={`lsu-model ${r.id === current ? 'on' : ''}`}>
          <span className={`led ${r.loaded ? 'on' : ''}`} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="mono ellipsis" style={{ fontSize: 13 }}>{r.id}</div>
            <div className="row wrap" style={{ gap: 4, marginTop: 3 }}>
              <span className={`chip ${r.tools === 'yes' ? 'settled' : r.tools === 'likely' ? '' : 'attention'}`}>{r.tools === 'yes' ? 'Tool calling' : r.tools === 'likely' ? 'Probably calls tools' : 'Text only'}</span>
              {r.fits !== 'unknown' && <span className={`chip ${r.fits === 'fast' ? '' : r.fits === 'slow' ? 'attention' : 'problem'}`}>{r.fits === 'fast' ? 'Fits' : r.fits === 'slow' ? 'Slower — partly CPU' : 'Too big'}</span>}
              {r.tps !== undefined && <span className="chip">~{Math.round(r.tps)} tok/s</span>}
              {r.context && <span className="chip">{k(r.context)} max</span>}
              {r.gb && <span className="chip">{r.gb} GB</span>}
            </div>
          </div>
          {r.id === current ? <span className="small faint">In use</span> : <Button size="sm" variant="ghost" onClick={() => onUse(r.id)}>Use</Button>}
        </div>
      ))}
    </div>
  );
}

const INSTALL: Record<'unix' | 'win', { label: string; cmds: string[] }> = {
  unix: { label: 'macOS · Linux', cmds: ['curl -fsSL https://lmstudio.ai/install.sh | bash', 'lms daemon up && lms server start'] },
  win: { label: 'Windows', cmds: ['irm https://lmstudio.ai/install.ps1 | iex', 'lms daemon up; lms server start'] },
};

function Install({ doc, compact, hw, suggestion, onCheck }: { doc: Doctor | null; compact: boolean; hw: LocalHardware | null; suggestion?: LocalSuggestion; onCheck: () => void }) {
  const [tab, setTab] = useState<'unix' | 'win'>(doc?.platform === 'win32' ? 'win' : 'unix');
  const [copied, setCopied] = useState('');
  const copy = (t: string) => { void navigator.clipboard?.writeText(t); setCopied(t); setTimeout(() => setCopied(''), 1400); };
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div>
        <div style={{ fontWeight: 600 }}>Install LM Studio and AUDA does the rest</div>
        <div className="small muted">Run this on the computer that should host the model{suggestion ? ` — AUDA has planned ${suggestion.name} (${suggestion.gb} GB${suggestion.tps ? `, ~${Math.round(suggestion.tps)} tokens/s` : ''}) for ${hw ? 'this one' : 'a typical one'}` : ''}. It notices within a minute, starts the server, downloads and loads the model.</div>
      </div>
      <Machine hw={hw} compact={compact} />
      <div className="row" style={{ gap: 6 }}>{(Object.keys(INSTALL) as ('unix' | 'win')[]).map((o) => <button key={o} className={`chip btnlike ${tab === o ? 'accent' : ''}`} onClick={() => setTab(o)}>{INSTALL[o].label}</button>)}</div>
      <div className="lsu-cmds">
        {INSTALL[tab].cmds.map((c) => (
          <button key={c} className="lsu-cmd" onClick={() => copy(c)} title="Copy">
            <span className="mono grow ellipsis">{c}</span><span className="small faint">{copied === c ? 'Copied' : 'Copy'}</span>
          </button>
        ))}
      </div>
      <div className="small muted">Prefer an app? <a href="https://lmstudio.ai/download" target="_blank" rel="noreferrer">Download LM Studio</a>, then turn on its server (Developer → Start server). On another computer — or when AUDA runs in Docker — also turn on “Serve on local network”.</div>
      <div className="row" style={{ gap: 8 }}><Button size="sm" variant="primary" icon="recover" onClick={onCheck}>I’ve installed it — check again</Button></div>
    </div>
  );
}

function Ready({ doc, live, compact, onPref, onUse, onDownload, onAgain }: { doc: Doctor | null; live: LocalSetupState | null; compact: boolean; onPref: (p: LocalPreference) => void; onUse: (id: string) => void; onDownload: (key: string) => void; onAgain: () => void }) {
  const l = useStore().settings!.models.local!;
  const [busy, setBusy] = useState(false);
  const [embedMsg, setEmbedMsg] = useState('');
  const justDone = live?.outcome === 'connected' && live.finishedAt && Date.now() - live.finishedAt < 5 * 60_000;
  const embedding = live?.result?.embeddings ?? (doc?.hasEmbeddings ? 'on' : null);
  const addEmbeddings = async () => {
    setBusy(true); setEmbedMsg('');
    try { const r = await post('/api/lmstudio/download-embeddings'); setEmbedMsg(`Knowledge search now uses ${r.model}.`); }
    catch (e) { setEmbedMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 12 }}>
      {justDone && live?.message && <div className="lsu-note settled"><Morph shape="check" size={14} /> {live.message}</div>}
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="chip settled">{l.tools ? 'Tool calling ✓' : 'Text only'}</span>
        {l.contextLength && <span className="chip">{k(l.contextLength)} context</span>}
        {l.tps && <span className="chip" title={live?.result?.predictedTps ? `AUDA predicted ~${Math.round(live.result.predictedTps)} and learns from the difference` : undefined}>~{l.tps} tokens/s{live?.result?.predictedTps ? ` (predicted ${Math.round(live.result.predictedTps)})` : ''}</span>}
        {live?.result?.placement && <span className="chip">{where(live.result, doc?.hardware)}</span>}
        {live?.result?.variant && <span className="chip">{live.result.variant}</span>}
        {l.manage !== false && <span className="chip" title="AUDA restarts the server, reloads the model and enlarges its context when needed">Kept running by AUDA</span>}
      </div>
      {!compact && live?.upgrade && (
        <div className="lsu-upgrade">
          <div className="small"><b>A better fit for this machine:</b> {live.upgrade.name} {live.upgrade.variant ? `(${live.upgrade.variant})` : ''} — smarter{live.upgrade.tps ? `, still ~${Math.round(live.upgrade.tps)} tokens/s` : ''}. {live.upgrade.gb} GB download.</div>
          <Button size="sm" icon="arrowRight" onClick={() => onDownload(live.upgrade!.key)}>Download &amp; switch</Button>
        </div>
      )}
      {!compact && doc?.hardware && <Machine hw={doc.hardware} compact />}
      {!compact && doc?.hardware && <div className="row wrap" style={{ gap: 10 }}><PrefSwitch value={doc.preference} onChange={onPref} /><span className="small faint">Changes what “Run setup again” plans.</span></div>}
      {!compact && !embedding && doc?.api === 'v1' && (
        <div className="lsu-embed row" style={{ gap: 10 }}>
          <div className="grow small"><b>Sharper knowledge search</b><div className="muted">Add {doc.embedding.name} ({Math.round(doc.embedding.gb * 1000)} MB) so agents find the right passages in their knowledge.</div></div>
          <Button size="sm" busy={busy} onClick={addEmbeddings}>Add</Button>
        </div>
      )}
      {embedMsg && <div className="small muted">{embedMsg}</div>}
      {!compact && doc && doc.ranked.length > 1 && (
        <details className="lsu-more">
          <summary className="small">Models on this server ({doc.ranked.length})</summary>
          <ModelList ranked={doc.ranked} current={l.model} onUse={onUse} />
        </details>
      )}
      {!compact && <div><Button size="sm" variant="ghost" icon="recover" onClick={onAgain}>Run setup again</Button></div>}
    </div>
  );
}
