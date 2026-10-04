/**
 * AUDA's Computer — its desk. Watch it work in its own browser and terminal,
 * take control when you want to, and hand it back. AUDA knows who is driving.
 */
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore, subscribe, onStream } from '../lib/store';
import { api, post } from '../lib/api';
import { Segmented, Button, Empty } from '../components/controls';
import { Morph } from '../motion/Morph';
import { fm } from '../motion/spring';
import { bytes, ago, clock } from '../lib/time';
import { openSheet } from '../components/ui';

interface TermLine { ts: number; actor: 'auda' | 'human'; kind: 'cmd' | 'out' | 'err' | 'note'; text: string }

function Screen({ human }: { human: boolean }) {
  const s = useStore();
  const img = useRef<HTMLImageElement>(null);
  const [has, setHas] = useState(false);
  const [url, setUrl] = useState('');
  const b = s.computer?.browser;
  const [meta, setMeta] = useState<any>(b);
  useEffect(() => {
    const un = subscribe('screen');
    const off = onStream('screen', (f) => { if (img.current) { img.current.src = `data:image/jpeg;base64,${f.data}`; setHas(true); } });
    const off2 = onStream('screen.meta', (m) => setMeta(m));
    return () => { un(); off(); off2(); };
  }, []);
  useEffect(() => { if (!human) setUrl(meta?.url ?? ''); }, [meta?.url, human]);
  const send = (e: any) => post('/api/computer/browser', e).catch(() => {});
  const coords = (ev: React.MouseEvent) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: Math.round(((ev.clientX - r.left) / r.width) * 1280), y: Math.round(((ev.clientY - r.top) / r.height) * 800) };
  };
  const reading = meta?.activity && Date.now() - meta.activity.ts < 15000;
  return (
    <div className={`screen ${human ? 'human' : ''}`}>
      <div className="screen-bar">
        <span className="dots3"><i /><i /><i /></span>
        <form className="grow" onSubmit={(e) => { e.preventDefault(); if (human) send({ type: 'navigate', url: /^https?:/.test(url) ? url : `https://${url}` }); }}>
          <input className="url" value={url} onChange={(e) => setUrl(e.target.value)} readOnly={!human} aria-label="Address" />
        </form>
        {human && <><button className="btn ghost sm" onClick={() => send({ type: 'back' })}>Back</button><button className="btn ghost sm" onClick={() => send({ type: 'reload' })}>Reload</button></>}
      </div>
      <div className="screen-view" tabIndex={human ? 0 : -1}
        onClick={(e) => human && send({ type: 'click', ...coords(e) })}
        onWheel={(e) => human && send({ type: 'wheel', deltaY: e.deltaY })}
        onKeyDown={(e) => { if (!human) return; e.preventDefault(); if (e.key.length === 1) send({ type: 'type', text: e.key }); else send({ type: 'key', key: e.key }); }}>
        <img ref={img} alt="AUDA's browser" style={{ opacity: has ? 1 : 0 }} />
        {!has && (
          <div className="screen-empty">
            <Morph shape="rest" size={34} color="var(--ink-3)" />
            <p>{b?.available ? 'The browser is asleep. It wakes when AUDA needs it.' : 'No Chromium on this computer yet.'}</p>
            {b?.available && <Button size="sm" onClick={() => post('/api/computer/browser/open')}>Wake browser</Button>}
          </div>
        )}
        <AnimatePresence>
          {reading && !human && (
            <motion.div className="screen-overlay" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={fm.settle}>
              <Morph shape="eye" size={16} color="var(--accent)" /> AUDA is {meta.activity.action.toLowerCase()} {meta.activity.url}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Terminal({ human }: { human: boolean }) {
  const [lines, setLines] = useState<TermLine[]>([]);
  const [cmd, setCmd] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api('/api/computer').then((c) => setLines(c.transcript));
    return onStream('terminal', (l: TermLine) => setLines((xs) => [...xs.slice(-500), l]));
  }, []);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [lines.length]);
  return (
    <div className="terminal">
      <div className="terminal-scroll" ref={box}>
        {lines.map((l, i) => (
          <div key={i} className={`tline ${l.kind} ${l.actor}`}>
            {l.kind === 'cmd' && <span className="prompt">{l.actor === 'human' ? 'you' : 'auda'} $ </span>}
            {l.kind === 'note' && <span className="prompt">— </span>}
            <span>{l.text}</span>
            {l.kind === 'cmd' && <span className="tts">{clock(l.ts)}</span>}
          </div>
        ))}
        {!lines.length && <div className="tline note">Nothing has run yet.</div>}
      </div>
      <form className="terminal-input" onSubmit={async (e) => { e.preventDefault(); if (!cmd.trim()) return; const c = cmd; setCmd(''); await post('/api/computer/terminal', { cmd: c }).catch(() => {}); }}>
        <span className="prompt">{human ? 'you $' : 'auda $'}</span>
        <input value={cmd} onChange={(e) => setCmd(e.target.value)} disabled={!human} placeholder={human ? 'Type a command' : 'Take control to type here'} aria-label="Terminal command" />
      </form>
    </div>
  );
}

function Files() {
  const s = useStore();
  const [path, setPath] = useState('~');
  const [data, setData] = useState<any>(null);
  const [file, setFile] = useState<any>(null);
  useEffect(() => { api(`/api/computer/fs?path=${encodeURIComponent(path)}`).then(setData).catch(() => setData(null)); setFile(null); }, [path, Object.keys(s.artifacts).length]);
  const crumbs = path.split('/');
  return (
    <div className="files">
      <div className="row crumbs">
        {crumbs.map((c, i) => <button key={i} className="crumb" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c === '~' ? 'home' : c}</button>)}
      </div>
      <div className="file-list">
        {data?.entries.map((e: any) => {
          const art = Object.values(s.artifacts).find((a) => a.path === e.path);
          return (
            <button key={e.path} className="file-row" onClick={async () => e.dir ? setPath(e.path) : art ? openSheet({ type: 'artifact', id: art.id }) : setFile({ path: e.path, ...(await api(`/api/computer/file?path=${encodeURIComponent(e.path)}`)) })}>
              <Morph shape={e.dir ? 'chevronRight' : 'rest'} size={14} color="var(--ink-3)" animate={false} />
              <span className="grow ellipsis">{e.name}</span>
              {art && <span className="small faint ellipsis why-inline">{art.why}</span>}
              {!e.dir && <span className="small faint tnum">{bytes(e.size)}</span>}
              <span className="small faint">{ago(e.mtime)}</span>
            </button>
          );
        })}
        {data && !data.entries.length && <div className="faint small" style={{ padding: 12 }}>Empty folder.</div>}
      </div>
      {file && <div className="file-preview"><div className="row"><span className="mono grow">{file.path}</span><button className="btn ghost sm" onClick={() => setFile(null)}>Close</button></div><pre className="raw mono">{file.text}{file.truncated ? '\n…' : ''}</pre></div>}
    </div>
  );
}

function Services() {
  const s = useStore();
  const [live, setLive] = useState<Record<string, any>>({});
  useEffect(() => onStream('services', (x) => setLive((m) => ({ ...m, [x.name]: x }))), []);
  const list = (s.computer?.services ?? []).map((x) => live[x.name] ?? x);
  return (
    <div className="stack">
      {list.map((svc) => (
        <div key={svc.name} className="service">
          <div className="row">
            <span className={`led ${svc.running ? 'on' : ''}`} />
            <div className="grow"><div style={{ fontWeight: 600 }}>{svc.name}</div><div className="small faint">{svc.running ? `running · pid ${svc.pid}` : 'stopped'} · {svc.path}</div></div>
            <Segmented id={`lvl-${svc.name}`} size="sm" value={svc.logLevel ?? 'info'} onChange={(v) => post(`/api/computer/services/${svc.name}/configure`, { key: 'logLevel', value: v })}
              options={[{ value: 'info', label: 'info' }, { value: 'debug', label: 'debug' }]} />
          </div>
          <p className="small muted" style={{ margin: '10px 0' }}>A small service living on AUDA’s computer so it has something real to look after. Switching logging to <b>debug</b> makes it write ~450 KB/s — enough to fill its 48 MB volume in a couple of minutes.</p>
          <div className="row" style={{ gap: 8 }}>
            {svc.running ? <Button size="sm" icon="stop" onClick={() => post(`/api/computer/services/${svc.name}/stop`)}>Stop</Button> : <Button size="sm" icon="play" onClick={() => post(`/api/computer/services/${svc.name}/start`)}>Start</Button>}
            <Button size="sm" variant="ghost" icon="recover" onClick={() => post(`/api/computer/services/${svc.name}/restart`)}>Restart</Button>
          </div>
        </div>
      ))}
      {!list.length && <Empty title="No services" />}
    </div>
  );
}

export function Computer() {
  const s = useStore();
  const c = s.computer;
  const [pane, setPane] = useState<'files' | 'services'>('services');
  if (!c) return null;
  const human = c.controller === 'human';
  return (
    <div>
      <div className="page-head">
        <div><h1 className="title-lg">AUDA’s Computer</h1><p>{c.driver.label} · persistent across restarts. This is AUDA’s desk, separate from your machines.</p></div>
        <div className="row">
          <Segmented id="control" value={human ? 'human' : 'auda'} onChange={(v) => post('/api/computer/control', { who: v })}
            options={[{ value: 'auda', label: <><Morph shape={human ? 'eye' : 'orbit'} size={14} /> AUDA drives</> }, { value: 'human', label: <><Morph shape="play" size={14} /> Take control</> }]} />
        </div>
      </div>
      <AnimatePresence>
        {human && (
          <motion.div className="control-banner" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={fm.glide}>
            <Morph shape="attention" size={18} color="var(--attention)" />
            <span className="grow">You’re driving. AUDA has paused anything that needs this computer and will continue when you hand it back.</span>
            <Button size="sm" variant="primary" onClick={() => post('/api/computer/control', { who: 'auda' })}>Return control to AUDA</Button>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="computer-grid">
        <div className="stack" style={{ gap: 14 }}>
          <Screen human={human} />
          <Terminal human={human} />
        </div>
        <div className="stack" style={{ gap: 14 }}>
          <div className="card">
            <Segmented id="pane" size="sm" value={pane} onChange={setPane} options={[{ value: 'services', label: 'Services' }, { value: 'files', label: 'Files' }]} />
            <div style={{ marginTop: 14 }}>{pane === 'services' ? <Services /> : <Files />}</div>
          </div>
          <details className="card advanced">
            <summary>Reliability</summary>
            <p className="small muted">An independent supervisor health-checks the browser every 5 seconds. Freeze it to watch AUDA notice, restart it and restore the page — the recovery appears in Activity.</p>
            <Button size="sm" icon="problem" onClick={() => post('/api/computer/browser/hang')}>Freeze the browser</Button>
          </details>
        </div>
      </div>
    </div>
  );
}
