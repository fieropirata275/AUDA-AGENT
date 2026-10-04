/** Connections are pieces of AUDA's environment, each with explicit permissions. */
import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore } from '../lib/store';
import { api, post } from '../lib/api';
import { Button, Toggle, Empty } from '../components/controls';
import { Morph } from '../motion/Morph';
import { fm } from '../motion/spring';
import { ago } from '../lib/time';
import type { Connector, CatalogItem } from '../lib/types';

const LEVEL: Record<string, string> = { autonomous: 'On its own', rule: 'By your rules', approval: 'Asks you', deny: 'Never' };
const LEVELS = ['autonomous', 'rule', 'approval', 'deny'];

function LevelPicker({ cap, level }: { cap: string; level: string }) {
  return (
    <div className="level-picker" role="group" aria-label={`Autonomy for ${cap}`}>
      {LEVELS.map((l) => (
        <button key={l} aria-pressed={l === level} onClick={() => post('/api/permissions', { capability: cap, level: l })} title={LEVEL[l]}>
          {l === level && <motion.span layoutId={`lvl-${cap}`} className="thumb" transition={fm.settle} />}
          <span>{LEVEL[l]}</span>
        </button>
      ))}
    </div>
  );
}

function ConnectorCard({ c, cat }: { c?: Connector; cat: CatalogItem }) {
  const s = useStore();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const connected = c?.state === 'connected';
  const connect = async () => {
    setBusy(true); setErr('');
    try { await post(`/api/connectors/${cat.kind}`, cat.kind === 'anthropic' ? { key: token } : { token }); setToken(''); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <motion.article layout className={`conn ${connected ? 'on' : ''} ${c?.state === 'degraded' || c?.state === 'error' ? 'bad' : ''}`} transition={fm.glide}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="conn-plug"><Morph shape={connected ? 'linked' : busy ? 'flow' : 'unplugged'} size={26} color={connected ? 'var(--accent)' : 'var(--ink-3)'} spring={{ stiffness: 260, damping: 18 }} /></div>
        <div className="grow">
          <div className="row"><h3 className="title" style={{ fontSize: 16 }}>{cat.name}</h3><span className={`chip ${connected ? 'settled' : c?.state === 'degraded' ? 'problem' : ''}`}>{c?.state === 'degraded' ? 'Cooling down' : connected ? 'Connected' : 'Not connected'}</span></div>
          <div className="small muted" style={{ marginTop: 2 }}>{c?.detail ?? cat.description}</div>
          {c?.error && <div className="small" style={{ color: 'var(--problem)', marginTop: 4 }}>{c.error}</div>}
        </div>
      </div>
      {cat.kind === 'webhook' && <div className="mono small well" style={{ padding: '8px 12px', marginTop: 12 }}>POST {s.publicUrl}/hooks/&lt;name&gt;</div>}
      {cat.setup === 'token' && !connected && (
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="small faint">{cat.tokenHelp}</div>
          <div className="row"><input className="input" type="password" placeholder={cat.kind === 'anthropic' ? 'sk-ant-…' : 'github_pat_…'} value={token} onChange={(e) => setToken(e.target.value)} /><Button variant="primary" busy={busy} disabled={!token} onClick={connect}>Connect</Button></div>
          {err && <div className="chip problem">{err}</div>}
        </div>
      )}
      {c && c.capabilities.length > 0 && (
        <>
          <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={() => setOpen(!open)}><Morph shape={open ? 'chevronDown' : 'chevronRight'} size={14} /> What AUDA may do here</button>
          <AnimatePresence>{open && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={fm.glide} style={{ overflow: 'hidden' }}>
              <div className="perm-list">{c.capabilities.map((p) => <div key={p.id} className="perm"><span className="grow">{p.title}<span className="mono faint small"> {p.id}</span></span><LevelPicker cap={p.id} level={p.level} /></div>)}</div>
            </motion.div>
          )}</AnimatePresence>
          {!open && <div className="perm-summary small">{c.capabilities.slice(0, 4).map((p) => <span key={p.id}><b>{p.title}</b> — {LEVEL[p.level].toLowerCase()}</span>)}</div>}
        </>
      )}
      {connected && cat.setup === 'token' && !(cat.kind === 'anthropic' && s.settings?.models.anthropicFromEnv) && <Button size="sm" variant="ghost" className="danger" onClick={() => api(`/api/connectors/${cat.kind}`, { method: 'DELETE' })}>Disconnect</Button>}
    </motion.article>
  );
}

const ROLE_LABEL: Record<string, string> = { reasoning: 'Agents & chat', utility: 'Summaries & rules', coding: 'Code & CI', vision: 'Images' };

/** LM Studio: detect → pick a model → probe tool calling → connect. */
function LmStudioCard({ c }: { c?: Connector }) {
  const s = useStore();
  const local = s.settings?.models.local;
  const [found, setFound] = useState<any[] | null>(null);
  const [baseUrl, setBaseUrl] = useState(local?.baseUrl ?? '');
  const [models, setModels] = useState<any[]>([]);
  const [model, setModel] = useState(local?.model ?? '');
  const [roles, setRoles] = useState<string[]>(['reasoning', 'utility', 'coding', 'vision']);
  const [busy, setBusy] = useState<'' | 'detect' | 'connect'>('');
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  const connected = c?.state === 'connected' && local?.baseUrl;
  const detect = async () => {
    setBusy('detect'); setMsg(null);
    try {
      const r = await api('/api/lmstudio/detect');
      setFound(r.found);
      const first = r.found.find((f: any) => f.flavor === 'lmstudio') ?? r.found[0];
      if (first) { setBaseUrl(first.baseUrl); setModels(first.models.filter((m: any) => m.type !== 'embeddings')); setModel((m) => m || first.models.find((x: any) => x.state === 'loaded' && x.type !== 'embeddings')?.id || first.models[0]?.id || ''); }
      else setMsg({ tone: 'problem', text: 'No LM Studio server found. Start it with `lms server start` (or enable “Serve on Local Network” in LM Studio), or enter its address.' });
    } finally { setBusy(''); }
  };
  const loadModels = async () => {
    setBusy('detect'); setMsg(null);
    try { const r = await api(`/api/lmstudio/models?baseUrl=${encodeURIComponent(baseUrl)}`); setModels(r.models.filter((m: any) => m.type !== 'embeddings')); }
    catch (e) { setMsg({ tone: 'problem', text: (e as Error).message }); } finally { setBusy(''); }
  };
  const connect = async () => {
    setBusy('connect'); setMsg(null);
    try {
      const r = await post('/api/lmstudio/connect', { baseUrl, model, roles });
      setMsg(r.tools ? { tone: 'settled', text: `Connected. ${model} can call tools, so it can run agents.` } : { tone: 'attention', text: `Connected for text tasks. ${model} didn’t call the test tool, so agents will need a tool-capable model (e.g. Qwen3, Llama 3.1+, Mistral Small).` });
    } catch (e) { setMsg({ tone: 'problem', text: (e as Error).message }); } finally { setBusy(''); }
  };
  return (
    <motion.article layout className={`conn ${connected ? 'on' : ''} ${c?.state === 'error' || c?.state === 'degraded' ? 'bad' : ''}`} transition={fm.glide}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="conn-plug"><Morph shape={connected ? 'linked' : busy ? 'flow' : 'unplugged'} size={26} color={connected ? 'var(--accent)' : 'var(--ink-3)'} /></div>
        <div className="grow">
          <div className="row"><h3 className="title" style={{ fontSize: 16 }}>LM Studio</h3><span className={`chip ${connected ? 'settled' : c?.state === 'available' ? 'accent' : c?.state === 'error' ? 'problem' : ''}`}>{connected ? 'Connected' : c?.state === 'available' ? 'Found' : c?.state === 'error' ? 'Unreachable' : 'Not connected'}</span></div>
          <div className="small muted" style={{ marginTop: 2 }}>{c?.detail ?? 'Run AUDA on local models through LM Studio’s headless server. Nothing leaves your network.'}</div>
          {c?.error && <div className="small" style={{ color: 'var(--problem)', marginTop: 4 }}>{c.error}</div>}
        </div>
      </div>
      <div className="stack" style={{ marginTop: 12 }}>
        <div className="row">
          <input className="input" placeholder="http://127.0.0.1:1234" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} onBlur={() => baseUrl && loadModels()} />
          <Button size="sm" busy={busy === 'detect'} onClick={detect}>Find</Button>
        </div>
        {found && found.length > 1 && <div className="row wrap" style={{ gap: 6 }}>{found.map((f) => <button key={f.baseUrl} className={`chip btnlike ${f.baseUrl === baseUrl ? 'accent' : ''}`} onClick={() => { setBaseUrl(f.baseUrl); setModels(f.models.filter((m: any) => m.type !== 'embeddings')); }}>{f.baseUrl}</button>)}</div>}
        {models.length > 0 && (
          <div className="model-list">{models.map((m) => (
            <button key={m.id} className={`model-row ${m.id === model ? 'on' : ''}`} onClick={() => setModel(m.id)}>
              <span className={`led ${m.state === 'loaded' ? 'on' : ''}`} />
              <span className="grow ellipsis mono">{m.id}</span>
              <span className="small faint">{[m.quantization, m.contextLength ? `${Math.round(m.contextLength / 1024)}k` : null, m.state === 'loaded' ? 'loaded' : m.state === 'not-loaded' ? 'loads on first use' : null].filter(Boolean).join(' · ')}</span>
            </button>
          ))}</div>
        )}
        {models.length > 0 && (
          <div className="row wrap" style={{ gap: 6 }}><span className="small faint">Use for</span>{Object.keys(ROLE_LABEL).map((r) => <button key={r} className={`chip btnlike ${roles.includes(r) ? 'accent' : ''}`} onClick={() => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r])}>{ROLE_LABEL[r]}</button>)}</div>
        )}
        {msg && <div className={`chip ${msg.tone}`} style={{ height: 'auto', padding: '6px 10px', whiteSpace: 'normal' }}>{msg.text}</div>}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          {connected && <Button size="sm" variant="ghost" className="danger" onClick={() => api('/api/lmstudio', { method: 'DELETE' })}>Disconnect</Button>}
          <Button size="sm" variant="primary" busy={busy === 'connect'} disabled={!baseUrl || !model || !roles.length} onClick={connect}>{connected ? 'Reconnect' : 'Test & connect'}</Button>
        </div>
      </div>
    </motion.article>
  );
}

/** Phones and tablets: pairing requests, paired apps, and LAN access. */
function Phones() {
  const s = useStore();
  const [name, setName] = useState(s.settings?.instanceName || s.instance?.name || '');
  const pending = Object.values(s.pairings).filter((p) => p.state === 'pending' && p.expiresAt > Date.now());
  const clients = Object.values(s.clients).filter((c) => !c.revokedAt);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <AnimatePresence>{pending.map((p) => (
        <motion.div key={p.id} layout className="pair-request" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }} transition={fm.glide}>
          <Morph shape="attention" size={20} color="var(--attention)" />
          <div className="grow"><div style={{ fontWeight: 600 }}>{p.name} wants to connect{p.platform ? ` · ${p.platform}` : ''}</div><div className="small muted">Approve only if the same code is showing on your device.</div></div>
          <div className="pair-code tnum">{p.code.slice(0, 3)} {p.code.slice(3)}</div>
          <Button size="sm" variant="ghost" onClick={() => post(`/api/pair/${p.id}/reject`)}>Decline</Button>
          <Button size="sm" variant="primary" onClick={() => post(`/api/pair/${p.id}/approve`)}>Approve</Button>
        </motion.div>
      ))}</AnimatePresence>
      {clients.map((c) => (
        <div key={c.id} className="conn on"><div className="row">
          <span className={`led ${c.lastSeenAt && Date.now() - c.lastSeenAt < 5 * 60_000 ? 'on' : ''}`} />
          <div className="grow"><div style={{ fontWeight: 600 }}>{c.name}</div><div className="small faint">{c.platform ?? 'App'} · paired {new Date(c.createdAt).toLocaleDateString()}{c.lastSeenAt ? ` · last seen ${ago(c.lastSeenAt)}` : ''}</div></div>
          <Button size="sm" variant="ghost" className="danger" onClick={() => api(`/api/clients/${c.id}`, { method: 'DELETE' })}>Revoke</Button>
        </div></div>
      ))}
      <div className="card flat stack" style={{ gap: 10 }}>
        <div className="row"><div className="grow"><div style={{ fontWeight: 560 }}>Name on the network</div><div className="small faint">What the AUDA app shows when it finds this instance.</div></div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void api('/api/settings/instance.name', { method: 'PUT', body: { value: name } }); }}><input className="input" style={{ width: 220 }} value={name} onChange={(e) => setName(e.target.value)} /><Button size="sm">Save</Button></form></div>
        <div className="row"><div className="grow"><div style={{ fontWeight: 560 }}>Require pairing on the network</div><div className="small faint">Only paired apps (and this computer) can use AUDA. Recommended unless your network is fully trusted.</div></div>
          <Toggle checked={!!s.settings?.requirePairing} onChange={(v) => api('/api/settings/security.requirePairing', { method: 'PUT', body: { value: v } })} /></div>
        <div className="small faint">The Android app finds this instance automatically (mDNS <span className="mono">_auda._tcp</span>, with a UDP fallback on port 4611). You can also enter <span className="mono">{s.publicUrl}</span>.</div>
      </div>
    </div>
  );
}

function Devices() {
  const s = useStore();
  const [name, setName] = useState('');
  const [pair, setPair] = useState<{ command: string } | null>(null);
  const devices = Object.values(s.devices).filter((d) => !d.revokedAt);
  return (
    <div className="stack" style={{ gap: 12 }}>
      {devices.map((d) => (
        <div key={d.id} className="conn on">
          <div className="row"><span className={`led ${d.state === 'online' ? 'on' : ''}`} /><div className="grow"><div style={{ fontWeight: 600 }}>{d.name}</div><div className="small faint">{d.state === 'online' ? 'Online' : `Offline${d.lastSeenAt ? ` · seen ${ago(d.lastSeenAt)}` : ' · not linked yet'}`}{d.platform ? ` · ${d.platform}` : ''}</div></div>
            <Button size="sm" variant="ghost" className="danger" onClick={() => api(`/api/devices/${d.id}`, { method: 'DELETE' })}>Revoke</Button></div>
          <div className="grants">{Object.entries(d.grants).map(([k, v]) => <label key={k} className="grant"><Toggle checked={v} onChange={(x) => post(`/api/devices/${d.id}/grants`, { [k]: x })} label={k} /><span>{k}</span></label>)}</div>
        </div>
      ))}
      <div className="row"><input className="input" placeholder="Name this device, e.g. “Henrique’s Desktop”" value={name} onChange={(e) => setName(e.target.value)} /><Button disabled={!name} onClick={async () => { setPair(await post('/api/devices', { name })); setName(''); }}>Link a device</Button></div>
      {pair && <div className="well" style={{ padding: 14 }}><div className="small">Run this on that machine. Nothing is granted until you switch it on above.</div><pre className="raw mono" style={{ marginTop: 8 }}>{pair.command}</pre></div>}
    </div>
  );
}

export function Connections() {
  const s = useStore();
  const available = s.catalog.filter((c) => c.available && c.kind !== 'device');
  const later = s.catalog.filter((c) => !c.available);
  return (
    <div>
      <div className="page-head"><div><h1 className="title-lg">Connections</h1><p>The services, machines and accounts that make up AUDA’s environment — and exactly what it may do with each.</p></div></div>
      <div className="grid-2">{available.map((cat) => cat.kind === 'lmstudio' ? <LmStudioCard key={cat.kind} c={s.connectors.lmstudio} /> : <ConnectorCard key={cat.kind} cat={cat} c={s.connectors[cat.kind]} />)}</div>
      <section className="section">
        <div className="section-head"><h2>Phones &amp; tablets</h2><span className="faint small">The AUDA app: chat, team, supervision. Pair once, revoke any time.</span></div>
        <Phones />
      </section>
      <section className="section">
        <div className="section-head"><h2>Your devices</h2><span className="faint small">Separate from AUDA’s computer. Explicit, visible, revocable.</span></div>
        <Devices />
      </section>
      <section className="section">
        <div className="section-head"><h2>Not in this build yet</h2></div>
        <div className="grid-3">{later.map((c) => <div key={c.kind} className="card flat"><div style={{ fontWeight: 600 }}>{c.name}</div><div className="small faint">{c.description}</div></div>)}</div>
        {!later.length && <Empty title="Everything is available" />}
      </section>
    </div>
  );
}
