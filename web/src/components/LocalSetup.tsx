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
import type { LocalHardware, LocalRanked, LocalSetupState, LocalSuggestion } from '../lib/types';

interface Doctor {
  baseUrl: string | null; api: string | null; error: string | null; hardware: LocalHardware | null; lms: string | null; local: boolean;
  found: { baseUrl: string; flavor: string; models: number }[]; models: { id: string; type: string; state: string }[];
  ranked: LocalRanked[]; suggestions: LocalSuggestion[]; embedding: LocalSuggestion; hasEmbeddings: boolean; platform: string;
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
  const refresh = () => api<Doctor>('/api/lmstudio/doctor').then(setDoc).catch((e) => setErr((e as Error).message));
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
          {view === 'intro' && doc && <Intro doc={doc} onStart={() => start()} />}
          {view === 'progress' && live && <Progress live={live} />}
          {view === 'pick' && live && <Pick live={live} doc={doc} compact={compact} onDownload={(key) => start({ download: key })} onUse={(id) => start({ model: id })} />}
          {view === 'install' && <Install doc={doc} hw={live?.hardware ?? doc?.hardware ?? null} suggestion={(live?.suggestions ?? doc?.suggestions)?.[0]} onCheck={() => start()} />}
          {view === 'failed' && live && (
            <div className="stack" style={{ gap: 10 }}>
              <Steps live={live} />
              <div className="lsu-note problem">{live.message}</div>
              <div className="row" style={{ gap: 8 }}><Button size="sm" variant="primary" icon="recover" onClick={() => start()}>Try again</Button></div>
            </div>
          )}
          {view === 'ready' && <Ready doc={doc} live={live} compact={compact} onUse={(id) => start({ model: id })} onAgain={() => start()} />}
        </motion.div>
      </AnimatePresence>
      {err && <div className="lsu-note problem" style={{ marginTop: 10 }}>{err}</div>}
    </div>
  );
}

function Hardware({ hw }: { hw: LocalHardware | null | undefined }) {
  if (!hw) return null;
  return <div className="lsu-hw small faint"><Morph shape="dots" size={13} /> This machine: {hw.summary}</div>;
}

function Intro({ doc, onStart }: { doc: Doctor; onStart: () => void }) {
  const ready = doc.ranked.find((r) => r.tools !== 'no' && r.fits !== 'no');
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div>
        <div style={{ fontWeight: 600 }}>{doc.baseUrl ? `LM Studio is running at ${doc.baseUrl.replace(/^https?:\/\//, '')}` : 'LM Studio is installed on this machine'}</div>
        <div className="small muted">{doc.baseUrl
          ? ready ? `${ready.id} looks right for agents. AUDA will load it with room to think, check it can use tools, and connect.` : `${doc.models.filter((x) => x.type !== 'embeddings').length || 'No'} model${doc.models.length === 1 ? '' : 's'} there yet that can run agents — AUDA will suggest one that suits this machine.`
          : 'Its server isn’t running. AUDA will start it, then pick and load a model.'}</div>
      </div>
      <Hardware hw={doc.hardware} />
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

function Pick({ live, doc, compact, onDownload, onUse }: { live: LocalSetupState; doc: Doctor | null; compact: boolean; onDownload: (key: string) => void; onUse: (id: string) => void }) {
  const others = (live.ranked ?? doc?.ranked ?? []).filter((r) => r.fits !== 'no' && r.id !== live.result?.model);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div>
        <div style={{ fontWeight: 600 }}>{live.outcome === 'text-only' ? `Connected ${live.result?.model} for text tasks` : 'LM Studio is ready — it needs one model'}</div>
        <div className="small muted">{live.outcome === 'text-only' ? 'Agents need a model that can use tools. One download fixes that:' : 'Agents need a model that can use tools. This one suits your machine:'}</div>
      </div>
      <Hardware hw={live.hardware} />
      <div className="lsu-sugs">
        {(live.suggestions ?? []).map((x) => (
          <div key={x.key} className={`lsu-sug ${x.recommended ? 'rec' : ''}`}>
            {x.recommended && <span className="chip accent lsu-rec">Best for this machine</span>}
            <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
              <b className="grow">{x.name}</b><span className="small faint tnum" style={{ whiteSpace: 'nowrap' }}>{x.gb} GB</span>
            </div>
            <div className="small muted">{x.why}</div>
            <div><Button size="sm" variant={x.recommended ? 'primary' : undefined} icon="arrowRight" onClick={() => onDownload(x.key)}>Download &amp; set up</Button></div>
          </div>
        ))}
      </div>
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

function Install({ doc, hw, suggestion, onCheck }: { doc: Doctor | null; hw: LocalHardware | null; suggestion?: LocalSuggestion; onCheck: () => void }) {
  const [tab, setTab] = useState<'unix' | 'win'>(doc?.platform === 'win32' ? 'win' : 'unix');
  const [copied, setCopied] = useState('');
  const copy = (t: string) => { void navigator.clipboard?.writeText(t); setCopied(t); setTimeout(() => setCopied(''), 1400); };
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div>
        <div style={{ fontWeight: 600 }}>Install LM Studio and AUDA does the rest</div>
        <div className="small muted">Run this on the computer that should host the model{suggestion ? ` — ${suggestion.name} (${suggestion.gb} GB) suits ${hw ? 'this one' : 'most'}` : ''}. AUDA notices within a minute, starts the server, downloads and loads the model.</div>
      </div>
      <Hardware hw={hw} />
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

function Ready({ doc, live, compact, onUse, onAgain }: { doc: Doctor | null; live: LocalSetupState | null; compact: boolean; onUse: (id: string) => void; onAgain: () => void }) {
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
        {l.tps && <span className="chip">~{l.tps} tokens/s</span>}
        {l.manage !== false && <span className="chip" title="AUDA restarts the server, reloads the model and enlarges its context when needed">Kept running by AUDA</span>}
      </div>
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
