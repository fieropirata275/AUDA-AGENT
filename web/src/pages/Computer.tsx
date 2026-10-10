/** AUDA Computer: dedicated Proxmox VM only. Never renders host browser or files. */
import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { Button } from '../components/controls';

interface VmView { name: string; state: string; controller: 'human'|'auda'; driver: { label: string } }
export function Computer() {
  const [vm, setVm] = useState<VmView | null>(null);
  const [error, setError] = useState('');
  const [cmd, setCmd] = useState('');
  const [output, setOutput] = useState('');
  const [listing, setListing] = useState('');
  const [screen, setScreen] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    try { setVm(await api('/api/computer')); setError(''); } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void refresh(); }, []);
  const take = async (who: 'human'|'auda') => { await post('/api/computer/control', {who}); await refresh(); };
  const command = async (e: React.FormEvent) => {
    e.preventDefault(); if (!cmd.trim()) return;
    setBusy(true);
    try { const r = await post('/api/computer/terminal', {cmd}); setOutput(`exit ${r.code}\n${r.stdout}\n${r.stderr || ''}`); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const list = async () => {
    try { const r = await api('/api/computer/fs?path=.'); setListing(r.listing); } catch (e) { setError((e as Error).message); }
  };
  const screenshot = async () => {
    try { const r = await api('/api/computer/desktop'); setScreen('data:image/png;base64,' + r.pngBase64); }
    catch (e) { setError((e as Error).message); }
  };
  const desktop = async (action: 'click'|'type'|'key', options: Record<string, unknown>) => {
    try { await post('/api/computer/desktop', {action, ...options}); await screenshot(); }
    catch (e) { setError((e as Error).message); }
  };
  return <div className="stack" style={{gap:16}}>
    <div className="page-head"><div><h1 className="title-lg">AUDA’s Computer</h1>
      <p>Exclusively a dedicated Proxmox VM cloned from your agent template. No host fallback.</p></div>
      <div className="row">
        <Button onClick={() => void refresh()}>Refresh</Button>
        <Button variant="primary" onClick={() => void take(vm?.controller === 'human' ? 'auda' : 'human')}>
          {vm?.controller === 'human' ? 'Return control to AUDA' : 'Take control'}
        </Button>
      </div>
    </div>
    {error && <div className="card" role="alert" style={{color:'var(--problem)'}}>{error}</div>}
    <div className="card"><strong>{vm?.name ?? 'Proxmox connection required'}</strong>
      <p className="small muted">{vm?.driver?.label ?? 'Connect Proxmox in Connections first.'} · {vm?.state ?? 'unavailable'}</p>
    </div>
    <div className="card stack" style={{gap:10}}>
      <div className="row"><strong>VM desktop</strong><Button size="sm" onClick={() => void screenshot()}>Refresh screenshot</Button></div>
      {screen ? <img alt="Live capture from guest VM" src={screen} style={{width:'100%',maxWidth:1000,objectFit:'contain',cursor:'crosshair'}}
        onClick={e => { if (vm?.controller !== 'human') return; const r=e.currentTarget.getBoundingClientRect(); const x=Math.round((e.clientX-r.left)*e.currentTarget.naturalWidth/r.width); const y=Math.round((e.clientY-r.top)*e.currentTarget.naturalHeight/r.height); void desktop('click',{x,y}); }} /> :
        <p className="small muted">Press Refresh screenshot. Guest must run X11 with xdotool and ImageMagick.</p>}
      <div className="row"><Button size="sm" onClick={() => { const key=prompt('Key, e.g. Return or ctrl+l'); if(key) void desktop('key',{key}); }}>Send key</Button>
        <Button size="sm" onClick={() => { const text=prompt('Type text into VM'); if(text) void desktop('type',{text}); }}>Type text</Button></div>
    </div>
    <div className="card stack" style={{gap:10}}><strong>VM terminal</strong>
      <form className="row" onSubmit={command}><input className="input grow" value={cmd} onChange={e=>setCmd(e.target.value)} placeholder="Command inside guest VM" /><Button type="submit" busy={busy} disabled={vm?.controller !== 'human'}>Run in VM</Button></form>
      <pre className="raw mono" style={{whiteSpace:'pre-wrap'}}>{output}</pre>
    </div>
    <div className="card stack" style={{gap:10}}><div className="row"><strong>VM files · /home/auda</strong><Button size="sm" onClick={() => void list()}>List files</Button></div>
      <pre className="raw mono" style={{whiteSpace:'pre-wrap'}}>{listing}</pre></div>
  </div>;
}
