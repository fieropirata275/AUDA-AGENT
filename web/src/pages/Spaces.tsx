/** Spaces scope work, memory, files and rules. */
import { useState } from 'react';
import { useStore } from '../lib/store';
import { post } from '../lib/api';
import { useRoute, navigate } from '../lib/router';
import { Button, Empty } from '../components/controls';
import { TaskCard } from '../components/TaskCard';
import { ResponsibilityCard } from '../components/ResponsibilityCard';
import { MemoryCard } from '../components/MemoryCard';
import { ArtifactRow } from '../components/Sheets';

export function Spaces() {
  const s = useStore();
  const { parts } = useRoute();
  const [name, setName] = useState('');
  const spaces = Object.values(s.spaces);
  const cur = parts[1] ? s.spaces[parts[1]] : null;
  const inSpace = (x: { spaceId?: string }) => (cur ? x.spaceId === cur.id : !x.spaceId);
  const title = cur?.name ?? 'Unscoped';
  const tasks = Object.values(s.tasks).filter(inSpace).sort((a, b) => b.updatedAt - a.updatedAt);
  const resps = Object.values(s.responsibilities).filter(inSpace).filter((r) => r.state !== 'ENDED');
  const mems = Object.values(s.memories).filter((m) => (cur ? m.spaceId === cur.id : !m.spaceId && m.scope === 'global')).filter((m) => !m.supersededBy);
  const arts = Object.values(s.artifacts).filter(inSpace).sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div>
      <div className="page-head"><div><h1 className="title-lg">Spaces</h1><p>Long-lived contexts. Each can hold its own responsibilities, memory, files and rules.</p></div></div>
      <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
        <button className={`chip btnlike ${!cur ? 'accent' : ''}`} onClick={() => navigate('/spaces')}>Unscoped</button>
        {spaces.map((sp) => <button key={sp.id} className={`chip btnlike ${cur?.id === sp.id ? 'accent' : ''}`} onClick={() => navigate(`/spaces/${sp.id}`)}>{sp.name}</button>)}
        <form className="row" onSubmit={async (e) => { e.preventDefault(); const r = await post('/api/spaces', { name }); setName(''); navigate(`/spaces/${r.id}`); }}><input className="input" style={{ width: 180, height: 30, padding: '4px 12px' }} placeholder="New space" value={name} onChange={(e) => setName(e.target.value)} /><Button size="sm" disabled={!name}>Add</Button></form>
      </div>
      <h2 className="voice" style={{ fontSize: 34, fontWeight: 400, margin: '20px 0 0' }}>{title}</h2>
      <section className="section"><div className="section-head"><h2>Responsibilities</h2><span className="n">{resps.length}</span></div><div className="grid-2">{resps.map((r) => <ResponsibilityCard key={r.id} r={r} />)}</div>{!resps.length && <Empty title="None here yet" />}</section>
      <section className="section"><div className="section-head"><h2>Tasks</h2><span className="n">{tasks.length}</span></div><div className="stack">{tasks.slice(0, 8).map((t) => <TaskCard key={t.id} task={t} />)}</div>{!tasks.length && <Empty title="No tasks" />}</section>
      <section className="section"><div className="section-head"><h2>Files</h2><span className="n">{arts.length}</span></div><div className="stack">{arts.slice(0, 10).map((a) => <ArtifactRow key={a.id} a={a} />)}</div>{!arts.length && <Empty title="No files" />}</section>
      <section className="section"><div className="section-head"><h2>Memory</h2><span className="n">{mems.length}</span></div><div className="mem-grid">{mems.slice(0, 8).map((m) => <MemoryCard key={m.id} m={m} />)}</div>{!mems.length && <Empty title="Nothing remembered here" />}</section>
    </div>
  );
}
