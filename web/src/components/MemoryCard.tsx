/** A memory is a structured piece of understanding — with provenance. */
import { useState } from 'react';
import { motion } from 'motion/react';
import type { Memory } from '../lib/types';
import { fm } from '../motion/spring';
import { api } from '../lib/api';
import { ago } from '../lib/time';
import { Morph } from '../motion/Morph';
import { Button } from './controls';

export const KIND_LABEL: Record<string, string> = {
  identity: 'Identity', preference: 'Preference', episodic: 'Episode', project: 'Project', operational: 'Operational', semantic: 'Fact',
  relationship: 'Relationship', procedural: 'Procedure', working: 'Scratch',
};
const WEIGHTS = ['mentioned', 'established', 'defining'] as const;

/** Three notches: mentioned once → established → defines how things work. */
export function WeightDial({ weight, onChange }: { weight: string; onChange?: (w: string) => void }) {
  const i = WEIGHTS.indexOf(weight as any);
  return (
    <div className="weight" role="group" aria-label={`Weight: ${weight}`} title={weight === 'defining' ? 'Defines how things work' : weight === 'established' ? 'Established through repetition' : 'Mentioned'}>
      {WEIGHTS.map((w, k) => (
        <button key={w} className={k <= i ? 'on' : ''} disabled={!onChange} onClick={() => onChange?.(w)} aria-label={w}>
          {k <= i && <motion.span layoutId={undefined} initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={fm.snap} />}
        </button>
      ))}
      <span className="small faint">{weight}</span>
    </div>
  );
}

export function MemoryCard({ m }: { m: Memory }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(m.title);
  const [content, setContent] = useState(m.content);
  const patch = (p: any) => api(`/api/memories/${m.id}`, { method: 'PATCH', body: p });
  return (
    <motion.article layout className={`memory k-${m.kind} ${m.supersededBy ? 'superseded' : ''}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: m.supersededBy ? 0.55 : 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }} transition={fm.glide}>
      <div className="row" style={{ gap: 8 }}>
        <span className="mem-kind">{KIND_LABEL[m.kind] ?? m.kind}</span>
        {m.pinned && <span className="chip accent">Pinned</span>}
        {m.sensitivity !== 'normal' && <span className="chip">{m.sensitivity}</span>}
        <span className="grow" />
        <WeightDial weight={m.weight} onChange={(w) => patch({ weight: w })} />
      </div>
      {editing ? (
        <div className="stack" style={{ marginTop: 10 }}>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea className="textarea" rows={3} value={content} onChange={(e) => setContent(e.target.value)} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={async () => { await patch({ title, content }); setEditing(false); }}>Save correction</Button>
          </div>
        </div>
      ) : (
        <>
          <h4 className="mem-title">{m.title}</h4>
          <p className="mem-content">{m.content}</p>
        </>
      )}
      <div className="mem-meta">
        <span title="How sure AUDA is">{Math.round(m.confidence * 100)}% sure</span>
        <span>·</span><span>from {m.source === 'user' ? 'you' : m.source}</span>
        <span>·</span><span>{m.scope === 'global' ? 'everywhere' : m.scope}</span>
        {m.reinforced > 1 && <><span>·</span><span>seen {m.reinforced}×</span></>}
        <span>·</span><span>{ago(m.updatedAt)}</span>
        {m.expiresAt && <><span>·</span><span>fades {new Date(m.expiresAt).toLocaleDateString()}</span></>}
        {m.supersededBy && <><span>·</span><span>folded into understanding</span></>}
      </div>
      {!editing && (
        <div className="mem-actions">
          <button className="btn ghost sm" onClick={() => patch({ pinned: !m.pinned })}><Morph shape={m.pinned ? 'check' : 'plus'} size={14} />{m.pinned ? 'Unpin' : 'Pin'}</button>
          <button className="btn ghost sm" onClick={() => setEditing(true)}>Correct</button>
          <button className="btn ghost sm danger" onClick={() => api(`/api/memories/${m.id}`, { method: 'DELETE' })}>Forget</button>
        </div>
      )}
    </motion.article>
  );
}
