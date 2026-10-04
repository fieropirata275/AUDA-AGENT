/**
 * Plugins: external apps your agents can use. Added once for the
 * organization; everyone connects their own account. Reads happen freely,
 * anything that changes data asks first.
 */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore } from '../lib/store';
import { api, post, patch, del } from '../lib/api';
import { Button, Toggle, Segmented, Empty } from '../components/controls';
import { Morph } from '../motion/Morph';
import { fm } from '../motion/spring';
import { ago } from '../lib/time';
import type { Plugin, Preset } from '../lib/types';

const ICON: Record<string, string> = { code: '⌥', calendar: '📅', folder: '🗂️', mail: '✉️', chat: '💬', doc: '📄', list: '☑️', plug: '🔌', globe: '🌐' };

/** Open the provider's consent screen in a popup and resolve when AUDA's callback reports back. */
function oauthPopup(url: string) {
  return new Promise<boolean>((resolve) => {
    const w = window.open(url, 'auda-oauth', 'width=520,height=720');
    if (!w) { location.assign(url); return; }
    const onMsg = (e: MessageEvent) => { if (e.data?.type === 'auda-oauth') { cleanup(); resolve(!!e.data.ok); } };
    const timer = setInterval(() => { if (w.closed) { cleanup(); resolve(false); } }, 600);
    const cleanup = () => { window.removeEventListener('message', onMsg); clearInterval(timer); };
    window.addEventListener('message', onMsg);
  });
}

function PluginCard({ p }: { p: Plugin }) {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  const [key, setKey] = useState('');
  const [needsKey, setNeedsKey] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const c = p.connection;
  const on = c?.state === 'connected' || p.auth === 'none';
  const run = async (k: string, fn: () => Promise<any>) => { setBusy(k); setMsg(null); try { await fn(); } catch (e) { setMsg({ tone: 'problem', text: (e as Error).message }); } finally { setBusy(''); } };
  const connect = () => run('connect', async () => {
    const r = await post(`/api/plugins/${p.id}/connect`, { returnTo: '/plugins' });
    if (r.needsKey) { setNeedsKey(true); return; }
    if (r.url) { const ok = await oauthPopup(r.url); setMsg(ok ? { tone: 'settled', text: `${p.name} is connected.` } : { tone: '', text: 'Not connected. You can try again any time.' }); }
  });
  const test = () => run('test', async () => { const r = await post(`/api/plugins/${p.id}/test`, {}); setMsg({ tone: 'settled', text: `${r.tool} answered (HTTP ${r.status}).` }); });
  return (
    <motion.article layout className={`conn ${on ? 'on' : ''} ${c?.state === 'expired' || c?.state === 'error' ? 'bad' : ''}`} transition={fm.glide}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="conn-plug" style={{ fontSize: 22 }}>{ICON[p.icon] ?? '🔌'}</div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <h3 className="title" style={{ fontSize: 16 }}>{p.name}</h3>
            <span className="chip">{p.kind === 'mcp' ? 'MCP' : 'API'}</span>
            <span className={`chip ${on ? 'settled' : c?.state === 'expired' || c?.state === 'error' ? 'problem' : ''}`}>{on ? 'Connected' : c?.state === 'expired' ? 'Expired — reconnect' : c?.state === 'error' ? 'Failed' : c?.state === 'connecting' ? 'Waiting for sign-in' : 'Not connected'}</span>
            {p.visibility === 'private' && <span className="chip">Only you</span>}
          </div>
          <div className="small muted" style={{ marginTop: 2 }}>{p.description}</div>
          {c?.account && <div className="small faint">Account: {c.account}{c.updatedAt ? ` · ${ago(c.updatedAt)}` : ''}</div>}
          {c?.error && !on && <div className="small" style={{ color: 'var(--problem)' }}>{c.error}</div>}
        </div>
      </div>
      {!p.oauthReady && (
        <div className="small" style={{ marginTop: 8, color: 'var(--attention)' }}>{p.canManage ? 'Add the OAuth client below so people can connect.' : 'Waiting for an admin to finish setting this up.'}</div>
      )}
      <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: 'wrap' }}>
        {!on && p.oauthReady && <Button size="sm" variant="primary" busy={busy === 'connect'} onClick={connect}>{p.auth === 'oauth2' ? `Sign in with ${p.name}` : 'Connect'}</Button>}
        {on && p.tools.some((t) => t.readOnly) && <Button size="sm" busy={busy === 'test'} onClick={test}>Test</Button>}
        {on && p.auth !== 'none' && <Button size="sm" variant="ghost" onClick={() => run('dis', () => post(`/api/plugins/${p.id}/disconnect`))}>Disconnect</Button>}
        {p.kind === 'mcp' && on && <Button size="sm" variant="ghost" busy={busy === 'tools'} onClick={() => run('tools', async () => { const r = await post(`/api/plugins/${p.id}/refresh-tools`); setMsg({ tone: 'settled', text: `${r.tools} tools.` }); })}>Refresh tools</Button>}
        <button className="btn ghost sm" onClick={() => setOpen(!open)}><Morph shape={open ? 'chevronDown' : 'chevronRight'} size={14} /> {p.tools.length} tools{p.canManage ? ' · settings' : ''}</button>
      </div>
      {needsKey && !on && (
        <div className="row" style={{ marginTop: 10 }}>
          <input className="input" type="password" placeholder={p.auth === 'bearer' ? 'Access token' : 'API key'} value={key} onChange={(e) => setKey(e.target.value)} />
          <Button variant="primary" busy={busy === 'key'} disabled={!key} onClick={() => run('key', () => post(`/api/plugins/${p.id}/key`, { key }).then(() => { setKey(''); setNeedsKey(false); }))}>Save</Button>
        </div>
      )}
      {msg && <div className={`chip ${msg.tone}`} style={{ marginTop: 8 }}>{msg.text}</div>}
      <AnimatePresence>{open && (
        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={fm.glide} style={{ overflow: 'hidden' }}>
          <div className="perm-list">
            {p.tools.map((t) => <div key={t.name} className="perm"><span className="grow"><span className="mono">{t.name}</span><div className="small faint">{t.description}</div></span><span className={`chip ${t.readOnly ? '' : 'attention'}`}>{t.readOnly ? 'Reads' : 'Changes data · asks'}</span></div>)}
            {!p.tools.length && <div className="small faint">{p.kind === 'mcp' ? 'Tools appear after the first connection.' : 'No tools.'}</div>}
          </div>
          {p.canManage && (
            <div className="stack" style={{ gap: 8, marginTop: 14 }}>
              {p.auth === 'oauth2' && !p.discovered && (
                <>
                  <div className="small muted">{p.setup ?? 'Register an OAuth app with the provider.'} Redirect URI:</div>
                  <div className="row"><code className="mono small well grow" style={{ padding: '8px 12px', overflowWrap: 'anywhere' }}>{p.redirectUri}</code><Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(p.redirectUri)}>Copy</Button></div>
                  <div className="row"><input className="input" placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} /><input className="input" type="password" placeholder="Client secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></div>
                  <Button size="sm" style={{ alignSelf: 'flex-start' }} busy={busy === 'client'} disabled={!clientId && !clientSecret} onClick={() => run('client', () => patch(`/api/plugins/${p.id}`, { ...(clientId ? { clientId } : {}), ...(clientSecret ? { clientSecret } : {}) }).then(() => { setClientId(''); setClientSecret(''); setMsg({ tone: 'settled', text: 'Saved.' }); }))}>Save OAuth client</Button>
                </>
              )}
              {s.org.enabled && <label className="set-row"><span className="grow">Available to everyone in {s.org.name}<div className="small faint">{p.connectedUsers} connected</div></span><Toggle checked={p.visibility === 'org'} onChange={(v) => patch(`/api/plugins/${p.id}`, { visibility: v ? 'org' : 'private' })} /></label>}
              <Button size="sm" variant="ghost" className="danger" style={{ alignSelf: 'flex-start' }} onClick={() => { if (confirm(`Remove ${p.name}? Everyone’s connection to it is deleted.`)) void del(`/api/plugins/${p.id}`); }}>Remove plugin</Button>
            </div>
          )}
        </motion.div>
      )}</AnimatePresence>
    </motion.article>
  );
}

function AddPlugin({ presets, existing }: { presets: Preset[]; existing: Set<string> }) {
  const [mode, setMode] = useState<'apps' | 'mcp' | 'openapi'>('apps');
  const [pick, setPick] = useState<Preset | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [auth, setAuth] = useState<'oauth' | 'apiKey' | 'none'>('oauth');
  const [header, setHeader] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const create = async (body: any) => {
    setBusy(true); setErr('');
    try { await post('/api/plugins', body); setPick(null); setUrl(''); setName(''); setClientId(''); setClientSecret(''); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="section">
      <div className="section-head"><h2>Add a plugin</h2></div>
      <Segmented id="add-plugin" value={mode} onChange={setMode} options={[{ value: 'apps', label: 'Popular apps' }, { value: 'mcp', label: 'MCP server' }, { value: 'openapi', label: 'Any API (OpenAPI)' }]} />
      <div style={{ marginTop: 14 }}>
        {mode === 'apps' && (
          <>
            <div className="tpl-row">
              {presets.map((pr) => (
                <button key={pr.id} className={`tpl ${pick?.id === pr.id ? 'on' : ''}`} disabled={existing.has(pr.id)} onClick={() => setPick(pr)} title={pr.description}>
                  <span>{ICON[pr.icon] ?? '🔌'}</span>{pr.name}{existing.has(pr.id) && <span className="faint small"> · added</span>}
                </button>
              ))}
            </div>
            <AnimatePresence>{pick && (
              <motion.div className="card flat stack" style={{ gap: 8, marginTop: 12 }} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={fm.glide}>
                <div style={{ fontWeight: 600 }}>{pick.name}</div>
                <div className="small muted">{pick.description} · {pick.tools} tools</div>
                <div className="small">{pick.setup} Use this redirect URI:</div>
                <RedirectUri />
                <div className="row"><input className="input" placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} /><input className="input" type="password" placeholder="Client secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></div>
                <div className="row"><Button variant="primary" busy={busy} onClick={() => create({ preset: pick.id, clientId, clientSecret })}>Add {pick.name}</Button><Button variant="ghost" onClick={() => setPick(null)}>Cancel</Button></div>
                <div className="small faint">You can add the client later; nobody can connect until it’s there.</div>
              </motion.div>
            )}</AnimatePresence>
          </>
        )}
        {mode === 'mcp' && (
          <div className="card flat stack" style={{ gap: 8 }}>
            <div className="small muted">A remote MCP server (Streamable HTTP). With sign-in on, AUDA discovers the server’s authorization and registers itself — no client setup needed.</div>
            <div className="row"><input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 200 }} /><input className="input" placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
            <label className="row small" style={{ gap: 8 }}><Toggle checked={auth === 'oauth'} onChange={(v) => setAuth(v ? 'oauth' : 'none')} /> Requires sign-in (OAuth)</label>
            <Button variant="primary" style={{ alignSelf: 'flex-start' }} busy={busy} disabled={!url} onClick={() => create({ kind: 'mcp', name: name || new URL(url).host, mcpUrl: url, auth: auth === 'oauth' ? { type: 'oauth2', discovered: true } : { type: 'none' } })}>Add MCP server</Button>
          </div>
        )}
        {mode === 'openapi' && (
          <div className="card flat stack" style={{ gap: 8 }}>
            <div className="small muted">Point to an OpenAPI 3 JSON document. AUDA turns up to 40 operations into tools (GET reads freely; everything else asks first) and picks up OAuth from the spec.</div>
            <div className="row"><input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 200 }} /><input className="input" placeholder="https://api.example.com/openapi.json" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
            <Segmented id="oa-auth" size="sm" value={auth} onChange={setAuth} options={[{ value: 'oauth', label: 'From the spec' }, { value: 'apiKey', label: 'API key' }, { value: 'none', label: 'None' }]} />
            {auth === 'apiKey' && <input className="input" placeholder="Header name (e.g. x-api-key)" value={header} onChange={(e) => setHeader(e.target.value)} />}
            {auth === 'oauth' && <div className="row"><input className="input" placeholder="Client ID (if OAuth)" value={clientId} onChange={(e) => setClientId(e.target.value)} /><input className="input" type="password" placeholder="Client secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></div>}
            <Button variant="primary" style={{ alignSelf: 'flex-start' }} busy={busy} disabled={!url} onClick={() => create({ kind: 'openapi', name: name || undefined, openapiUrl: url, clientId: clientId || undefined, clientSecret: clientSecret || undefined, ...(auth === 'apiKey' ? { auth: { type: 'apiKey', apiKeyHeader: header || 'x-api-key' } } : auth === 'none' ? { auth: { type: 'none' } } : {}) })}>Import</Button>
          </div>
        )}
        {err && <div className="chip problem" style={{ marginTop: 8 }}>{err}</div>}
      </div>
    </section>
  );
}

function RedirectUri() {
  const [uri, setUri] = useState('');
  useEffect(() => { api('/api/plugins').then((r) => setUri(r.redirectUri)).catch(() => {}); }, []);
  return <div className="row"><code className="mono small well grow" style={{ padding: '8px 12px', overflowWrap: 'anywhere' }}>{uri}</code><Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(uri)}>Copy</Button></div>;
}

export function Plugins() {
  const s = useStore();
  const [presets, setPresets] = useState<Preset[]>([]);
  useEffect(() => { api('/api/plugins').then((r) => setPresets(r.presets)).catch(() => {}); }, []);
  const plugins = Object.values(s.plugins).sort((a, b) => Number(!!b.connection) - Number(!!a.connection) || a.name.localeCompare(b.name));
  const existing = new Set(plugins.map((p) => p.preset).filter(Boolean) as string[]);
  return (
    <div>
      <div className="page-head"><div><h1 className="title-lg">Plugins</h1><p>Apps your agents can use. {s.org.enabled ? 'Added once for everyone, each person connects their own account' : 'Connect your account once'} — agents act with the account of whoever gave them the work, and ask before changing anything.</p></div></div>
      <div className="grid-2">{plugins.map((p) => <PluginCard key={p.id} p={p} />)}</div>
      {!plugins.length && <Empty title="No plugins yet">Add GitHub, Google, Slack, Notion, Linear, any MCP server or any OpenAPI service below.</Empty>}
      <AddPlugin presets={presets} existing={existing} />
    </div>
  );
}
