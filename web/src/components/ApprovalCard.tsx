/**
 * "Needs you" — the most important interaction in AUDA. It answers, at a
 * glance: why AUDA needs you, what it recommends, what happens on yes, what
 * happens on no, and exactly which actions you are authorising.
 */
import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { Approval } from '../lib/types';
import { fm } from '../motion/spring';
import { Morph } from '../motion/Morph';
import { post } from '../lib/api';
import { sound } from '../lib/sound';
import { openSheet } from './ui';
import { ago } from '../lib/time';

export function ApprovalCard({ a, dense }: { a: Approval; dense?: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'approving' | 'rejecting' | 'done'>('idle');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(!dense);
  const decide = async (decision: 'approved' | 'rejected') => {
    setPhase(decision === 'approved' ? 'approving' : 'rejecting');
    sound.click();
    try {
      await post(`/api/approvals/${a.id}/decide`, { decision });
      if (decision === 'approved') sound.complete();
      setTimeout(() => setPhase('done'), 420);
    } catch (e) { setErr((e as Error).message); setPhase('idle'); }
  };
  const decided = a.state !== 'pending';
  return (
    <motion.article layout className={`approval ${decided ? 'decided' : ''}`}
      initial={{ opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: phase === 'done' ? 0.98 : 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.96, height: 0, marginBottom: 0, transition: { ...fm.glide, opacity: { duration: 0.2 } } }}
      transition={fm.glide}>
      <header className="approval-head">
        <div className="approval-icon"><Morph shape={phase === 'approving' || a.state === 'approved' ? 'check' : phase === 'rejecting' || a.state === 'rejected' ? 'close' : 'attention'} size={22} color={a.state === 'approved' || phase === 'approving' ? 'var(--settled)' : 'var(--attention)'} /></div>
        <div className="grow">
          <div className="approval-kicker">{a.task?.title ?? 'A decision'} · asked {ago(a.createdAt)}</div>
          <h3 className="approval-title">{a.title}</h3>
        </div>
        {dense && <button className="btn ghost sm" onClick={() => setOpen(!open)} aria-expanded={open}><Morph shape={open ? 'chevronDown' : 'chevronRight'} size={15} /></button>}
      </header>
      <p className="approval-summary">{a.summary}</p>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={fm.glide} style={{ overflow: 'hidden' }}>
            {a.recommendation && (
              <div className="approval-rec">
                <span className="label">AUDA recommends</span>
                <div>{a.recommendation}</div>
                {a.impact && <div className="small muted" style={{ marginTop: 4 }}>{a.impact}</div>}
              </div>
            )}
            {(a.ifYes || a.ifNo) && (
              <div className="approval-paths">
                <div><span className="label">If you approve</span><p>{a.ifYes ?? 'AUDA goes ahead and verifies the result.'}</p></div>
                <div><span className="label">If you decline</span><p>{a.ifNo ?? 'AUDA stops and looks for another way.'}</p></div>
              </div>
            )}
            {a.evidence.length > 0 && (
              <dl className="kv approval-evidence">
                {a.evidence.map((e, i) => <div key={i} style={{ display: 'contents' }}><dt>{e.label}</dt><dd>{e.value}</dd></div>)}
              </dl>
            )}
            {a.actions.length > 0 && (
              <div className="approval-actions">
                <span className="label">Exactly what you’re authorising</span>
                <ul>{a.actions.map((x, i) => <li key={i}><Morph shape="chevronRight" size={13} color="var(--ink-3)" /> <span className="mono">{x.capability}</span> {x.describe}</li>)}</ul>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {err && <div className="chip problem" style={{ marginTop: 10 }}>{err}</div>}
      {!decided ? (
        <footer className="approval-foot">
          <motion.button className="btn primary lg" disabled={phase !== 'idle'} onClick={() => decide('approved')} whileTap={{ scale: 0.97, y: 1 }} transition={fm.snap}>
            <Morph shape={phase === 'approving' ? 'check' : 'arrowRight'} size={18} />
            {a.approveLabel ?? 'Approve'}
          </motion.button>
          <motion.button className="btn lg" disabled={phase !== 'idle'} onClick={() => decide('rejected')} whileTap={{ scale: 0.97, y: 1 }} transition={fm.snap}>
            {phase === 'rejecting' && <Morph shape="close" size={16} />}
            {a.rejectLabel ?? 'Don’t'}
          </motion.button>
          <button className="btn ghost lg" onClick={() => openSheet({ type: 'task', id: a.taskId })}>Inspect</button>
        </footer>
      ) : (
        <footer className="approval-foot decided-note small muted">
          {a.state === 'approved' ? 'You approved this' : a.state === 'rejected' ? 'You declined this' : 'No longer needed'}{a.decidedAt ? ` ${ago(a.decidedAt)}` : ''}.
        </footer>
      )}
    </motion.article>
  );
}
