/** Human-oriented activity timeline. Raw detail is one click away, never in the way. */
import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { Activity } from '../lib/types';
import { fm } from '../motion/spring';
import { clock, dayLabel } from '../lib/time';
import { Morph } from '../motion/Morph';
import { api } from '../lib/api';
import { openSheet } from './ui';

const KIND: Record<string, [string, string]> = {
  observe: ['eye', 'var(--ink-3)'], reason: ['wave', 'var(--ink-3)'], act: ['arrowRight', 'var(--accent)'], wait: ['clock', 'var(--ink-3)'],
  approval: ['attention', 'var(--attention)'], recover: ['recover', 'var(--attention)'], complete: ['check', 'var(--settled)'], problem: ['problem', 'var(--problem)'],
  memory: ['plus', 'var(--ink-3)'], system: ['dots', 'var(--ink-3)'], user: ['play', 'var(--ink-2)'], schedule: ['clock', 'var(--ink-3)'],
};

function Item({ a, showLinks }: { a: Activity; showLinks: boolean }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState<any>(null);
  const [shape, color] = KIND[a.kind] ?? ['dots', 'var(--ink-3)'];
  return (
    <motion.li layout="position" className={`tl-item k-${a.kind}`} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={fm.settle}>
      <span className="tl-time tnum">{clock(a.ts)}</span>
      <span className="tl-mark"><Morph shape={shape} size={14} color={color} animate={false} /></span>
      <div className="tl-body">
        <div className="tl-title">
          {a.title}
          {showLinks && a.taskId && <button className="tl-link" onClick={() => openSheet({ type: 'task', id: a.taskId! })}>task</button>}
          {showLinks && !a.taskId && a.responsibilityId && <button className="tl-link" onClick={() => openSheet({ type: 'responsibility', id: a.responsibilityId! })}>responsibility</button>}
        </div>
        {a.detail && <div className="tl-detail">{a.detail}</div>}
        {a.hasRaw && (
          <button className="tl-raw-btn" onClick={async () => { if (!raw) setRaw((await api(`/api/activity/${a.id}/raw`)).raw); setOpen(!open); }}>{open ? 'Hide raw output' : 'Raw output'}</button>
        )}
        <AnimatePresence>{open && raw && (
          <motion.pre className="tl-raw mono" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={fm.glide}>
            {typeof raw === 'string' ? raw : raw.stdout != null ? `${raw.stdout}${raw.stderr ? `\n${raw.stderr}` : ''}\n(exit ${raw.code}, ${raw.durationMs} ms)` : JSON.stringify(raw, null, 2)}
          </motion.pre>
        )}</AnimatePresence>
      </div>
    </motion.li>
  );
}

export function Timeline({ items, showLinks = true, groupByDay = true }: { items: Activity[]; showLinks?: boolean; groupByDay?: boolean }) {
  const groups: [string, Activity[]][] = [];
  for (const a of items) {
    const d = groupByDay ? dayLabel(a.ts) : '';
    if (!groups.length || groups[groups.length - 1][0] !== d) groups.push([d, []]);
    groups[groups.length - 1][1].push(a);
  }
  return (
    <div className="timeline">
      {groups.map(([d, xs]) => (
        <section key={d || 'all'}>
          {groupByDay && <h3 className="tl-day">{d}</h3>}
          <ol className="tl-list">{xs.map((a) => <Item key={a.id} a={a} showLinks={showLinks} />)}</ol>
        </section>
      ))}
    </div>
  );
}
