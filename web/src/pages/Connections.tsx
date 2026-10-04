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
      <div className="grid-2">{available.map((cat) => <ConnectorCard key={cat.kind} cat={cat} c={s.connectors[cat.kind]} />)}</div>
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
