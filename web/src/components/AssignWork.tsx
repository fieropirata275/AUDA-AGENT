/** Assign a piece of work to AUDA: what, what "done" means, and when. */
import { useState } from 'react';
import { useStore } from '../lib/store';
import { post } from '../lib/api';
import { Button } from './controls';
import { Morph } from '../motion/Morph';
import { openSheet } from './ui';

export function AssignWork() {
  const s = useStore();
  const [f, setF] = useState({ title: '', goal: '', criteria: '', when: '', spaceId: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const model = s.settings?.models.anthropicConnected;
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const r = await post<{ id: string }>('/api/tasks', { title: f.title, goal: f.goal || f.title, criteria: f.criteria || undefined, when: f.when || undefined, spaceId: f.spaceId || undefined });
      openSheet({ type: 'task', id: r.id });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="sheet-head">
        <div className="task-glyph lg"><Morph shape="plus" size={24} color="var(--accent)" /></div>
        <div className="grow"><div className="faint small">New task</div><h2 className="title" style={{ marginTop: 2 }}>Assign work to AUDA</h2></div>
        <button className="btn ghost icon" onClick={() => openSheet(null)} aria-label="Close"><Morph shape="close" size={18} /></button>
      </div>
      <div className="sheet-body">
        <form className="assign" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {!model && <div className="trouble small">No reasoning model is connected, so open-ended work will wait as “blocked” until you connect Claude in Connections.</div>}
          <label>What should AUDA do?<input className="input" autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Compare the three supplier quotes in ~/inbox and recommend one" /></label>
          <label>Details <span className="hint">Context, constraints, where things are. Optional.</span><textarea className="textarea" rows={5} value={f.goal} onChange={(e) => setF({ ...f, goal: e.target.value })} /></label>
          <label>Done when <span className="hint">How AUDA (and its reviewer) will know it’s finished. Concrete beats vague.</span><textarea className="textarea" rows={3} value={f.criteria} onChange={(e) => setF({ ...f, criteria: e.target.value })} placeholder="e.g. A comparison table is saved, prices are checked against the PDFs, and one option is recommended with reasons." /></label>
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <label className="grow">Start <span className="hint">Leave empty for now.</span><input className="input" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} placeholder="now · tonight at 22:00 · tomorrow morning" /></label>
            <label>Space<select className="input" value={f.spaceId} onChange={(e) => setF({ ...f, spaceId: e.target.value })}><option value="">None</option>{Object.values(s.spaces).map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}</select></label>
          </div>
          <div className="small faint">AUDA plans the work, splits independent parts across parallel sub-agents, asks only for real decisions, and has its result independently reviewed against “done when” before calling it finished.</div>
          {err && <div className="chip problem">{err}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="primary" size="lg" busy={busy} disabled={!f.title.trim()} icon="arrowRight">Assign</Button></div>
        </form>
      </div>
    </>
  );
}
