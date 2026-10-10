/**
 * A reply being worked on: what AUDA is doing right now, the steps so far, and a stop button — then, once
 * finished, a quiet "worked for 34 s · 6 steps" that unfolds into the same list.
 */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore } from '../lib/store';
import { post } from '../lib/api';
import { fm } from '../motion/spring';
import { Morph } from '../motion/Morph';
import { ApprovalCard } from './ApprovalCard';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const secs = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

export function useRun(taskId?: string) {
  const s = useStore();
  const task = taskId ? s.tasks[taskId] : undefined;
  const steps = taskId ? Object.values(s.activity).filter((a) => a.taskId === taskId && a.kind === 'act' && !/^Started a task|^Finished:|^Saved |^Delivered /.test(a.title)).sort((a, b) => a.ts - b.ts) : [];
  return { task, steps, running: !!task && !TERMINAL.has(task.state) };
}

export function RunLive({ taskId }: { taskId: string }) {
  const s = useStore();
  const { task, steps } = useRun(taskId);
  const [, tick] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const approvals = Object.values(s.approvals).filter((a) => a.taskId === taskId && a.state === 'pending');
  const now = task?.nowLine && !/^Getting ready|^Resuming/.test(task.nowLine) ? task.nowLine : 'Thinking…';
  return (
    <div className="run-live">
      <div className="run-now">
        <span className="run-spinner"><Morph shape="orbit" size={16} color="var(--accent)" /></span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={now} className="run-now-text" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={fm.settle}>{now}</motion.span>
        </AnimatePresence>
        <span className="small faint tnum">{task ? secs(Date.now() - (task.startedAt ?? task.createdAt)) : ''}</span>
        <button className="btn sm ghost" onClick={() => post(`/api/tasks/${taskId}/cancel`, {})} title="Stop">Stop</button>
      </div>
      {steps.length > 1 && (
        <button className="run-toggle small" onClick={() => setOpen(!open)}>{open ? 'Hide steps' : `${steps.length} steps so far`}</button>
      )}
      {open && <RunSteps steps={steps} />}
      {approvals.map((a) => <ApprovalCard key={a.id} a={a} dense />)}
    </div>
  );
}

export function RunSteps({ steps }: { steps: { id: string; title: string; ts: number }[] }) {
  return (
    <ol className="run-steps">
      {steps.map((st) => <li key={st.id}><span className="run-dot" /><span>{st.title}</span></li>)}
    </ol>
  );
}

export function RunDone({ taskId }: { taskId: string }) {
  const { task, steps } = useRun(taskId);
  const [open, setOpen] = useState(false);
  if (!task || !steps.length) return null;
  const took = task.completedAt && (task.startedAt ?? task.createdAt) ? secs(task.completedAt - (task.startedAt ?? task.createdAt)) : null;
  return (
    <div className="run-done">
      <button className="run-toggle small" onClick={() => setOpen(!open)}>
        <Morph shape={open ? 'chevronDown' : 'chevronRight'} size={11} /> {took ? `Worked for ${took}` : 'Worked'} · {steps.length} step{steps.length > 1 ? 's' : ''}
      </button>
      {open && <RunSteps steps={steps} />}
    </div>
  );
}
