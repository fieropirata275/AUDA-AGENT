/** What AUDA understands — structured, inspectable, correctable. */
import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, LayoutGroup } from 'motion/react';
import { useStore } from '../lib/store';
import { api, post } from '../lib/api';
import { MemoryCard, KIND_LABEL } from '../components/MemoryCard';
import { Button, Empty } from '../components/controls';
import type { Memory as M } from '../lib/types';

const ORDER = ['identity', 'preference', 'project', 'operational', 'procedural', 'relationship', 'semantic', 'episodic', 'working'];
const BLURB: Record<string, string> = {
  identity: 'Stable facts about you and about AUDA.', preference: 'How you like things done.', project: 'Long-running context.',
  operational: 'What AUDA needs to keep responsibilities running.', procedural: 'Workflows AUDA has learned.', relationship: 'People, systems and how they connect.',
  semantic: 'Useful facts discovered during work.', episodic: 'Things that happened.', working: 'Scratch context that fades on its own.',
};

export function Memory() {
  const s = useStore();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<string | null>(null);
  const [results, setResults] = useState<M[] | null>(null);
  const [showFolded, setShowFolded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ kind: 'preference', title: '', content: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!q.trim()) { setResults(null); return; }
    const t = setTimeout(() => api<M[]>(`/api/memories/search?q=${encodeURIComponent(q)}`).then(setResults), 180);
    return () => clearTimeout(t);
  }, [q, Object.keys(s.memories).length]);
  const all = useMemo(() => (results ?? Object.values(s.memories)).map((m) => s.memories[m.id] ?? m), [results, s.memories]);
  const visible = all.filter((m) => (showFolded || !m.supersededBy) && (!kind || m.kind === kind));
  const counts = Object.fromEntries(ORDER.map((k) => [k, Object.values(s.memories).filter((m) => m.kind === k && !m.supersededBy).length]));
  const groups = results ? [['Results', visible] as const] : ORDER.map((k) => [k, visible.filter((m) => m.kind === k).sort((a, b) => Number(b.pinned) - Number(a.pinned) || ['defining', 'established', 'mentioned'].indexOf(a.weight) - ['defining', 'established', 'mentioned'].indexOf(b.weight) || b.updatedAt - a.updatedAt)] as const).filter(([, xs]) => xs.length);

  return (
    <div>
      <div className="page-head">
        <div><h1 className="title-lg">Memory</h1><p>What AUDA understands. It knows the difference between something you mentioned once and something that defines how things work — and you can correct either.</p></div>
        <div className="row">
          <Button size="sm" variant="ghost" busy={busy} onClick={async () => { setBusy(true); await post('/api/memory/consolidate').finally(() => setBusy(false)); }}>Consolidate now</Button>
          <Button size="sm" icon="plus" onClick={() => setAdding(!adding)}>Teach AUDA</Button>
        </div>
      </div>
      {adding && (
        <div className="card stack" style={{ marginBottom: 18 }}>
          <div className="row wrap">{['preference', 'identity', 'project', 'relationship', 'semantic', 'procedural'].map((k) => <button key={k} className={`chip btnlike ${draft.kind === k ? 'accent' : ''}`} onClick={() => setDraft({ ...draft, kind: k })}>{KIND_LABEL[k]}</button>)}</div>
          <input className="input" placeholder="Short title, e.g. “Prototype deadline”" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <textarea className="textarea" rows={2} placeholder="What should AUDA understand?" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
          <div className="row" style={{ justifyContent: 'flex-end' }}><Button size="sm" variant="primary" disabled={!draft.title || !draft.content} onClick={async () => { await post('/api/memories', { ...draft, weight: 'established' }); setDraft({ kind: 'preference', title: '', content: '' }); setAdding(false); }}>Remember</Button></div>
        </div>
      )}
      <div className="mem-toolbar">
        <input className="input search" placeholder="Search what AUDA knows…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="row wrap" style={{ gap: 6 }}>
          <button className={`chip btnlike ${!kind ? 'accent' : ''}`} onClick={() => setKind(null)}>All</button>
          {ORDER.filter((k) => counts[k]).map((k) => <button key={k} className={`chip btnlike ${kind === k ? 'accent' : ''}`} onClick={() => setKind(kind === k ? null : k)}>{KIND_LABEL[k]} <span className="faint">{counts[k]}</span></button>)}
          <label className="small faint row" style={{ gap: 6, marginLeft: 6 }}><input type="checkbox" checked={showFolded} onChange={(e) => setShowFolded(e.target.checked)} /> show folded episodes</label>
        </div>
      </div>
      <LayoutGroup>
        {groups.map(([k, xs]) => (
          <section key={k} className="section">
            <div className="section-head"><h2>{KIND_LABEL[k] ?? k}</h2><span className="n">{xs.length}</span><span className="faint small">{BLURB[k]}</span></div>
            <div className="mem-grid"><AnimatePresence>{xs.map((m) => <MemoryCard key={m.id} m={m} />)}</AnimatePresence></div>
          </section>
        ))}
      </LayoutGroup>
      {!groups.length && <Empty title={q ? 'Nothing matches' : 'AUDA hasn’t learned anything yet'}>{q ? 'Try different words.' : 'Memories form as AUDA works and as you tell it things.'}</Empty>}
    </div>
  );
}
