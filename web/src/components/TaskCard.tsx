/** A task is a living object, not a Kanban ticket. */
import { motion } from 'motion/react';
import type { Task } from '../lib/types';
import { fm } from '../motion/spring';
import { TaskGlyph, TASK_LABEL } from './glyphs';
import { ago, until } from '../lib/time';
import { openSheet } from './ui';

export function StepPips({ task }: { task: Task }) {
  if (task.playbook === 'agent') return null;
  return (
    <div className="pips" aria-label={`${Math.min(task.currentStep, task.stepCount)} of ${task.stepCount} known steps`}>
      {task.steps.map((s) => (
        <motion.span key={s.idx} className={`pip ${s.state}`} layout transition={fm.settle}
          animate={{ scale: s.state === 'running' ? [1, 1.25, 1] : 1 }}
          {...(s.state === 'running' ? { transition: { repeat: Infinity, duration: 1.6 } } : {})} />
      ))}
    </div>
  );
}

export function progressText(t: Task) {
  if (t.state === 'COMPLETED') return t.completedAt ? `Finished ${ago(t.completedAt)}` : 'Finished';
  if (t.state === 'SCHEDULED') return `Starts ${until(t.nextEventAt)}`;
  if (t.state === 'RETRYING') return `Retry ${t.retryCount} of ${t.maxRetries} ${until(t.nextEventAt)}`;
  if (t.state === 'WAITING_EXTERNAL' && t.nextEventAt) return `Resumes ${until(t.nextEventAt)}`;
  if (t.playbook === 'agent') {
    if (t.plan?.length) return `${t.plan.filter((s) => s.status === 'done').length} of ${t.plan.length} planned steps`;
    return `${t.steps.filter((s) => s.state === 'done').length} turns so far`;
  }
  return `${Math.min(t.currentStep, t.stepCount)} of ${t.stepCount} known steps`;
}

export function TaskCard({ task, compact }: { task: Task; compact?: boolean }) {
  const active = task.state === 'RUNNING' || task.state === 'RECOVERING';
  const done = task.state === 'COMPLETED';
  return (
    <motion.button
      layout="position" layoutId={`task-${task.id}`}
      className={`task-card ${active ? 'active' : ''} ${done ? 'done' : ''} ${task.attention ? `att-${task.attention}` : ''}`}
      onClick={() => openSheet({ type: 'task', id: task.id })}
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: done ? 0.92 : 1, y: active ? -2 : 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
      whileTap={{ scale: 0.985, y: 0 }}
      transition={fm.glide}
    >
      <div className="task-glyph"><TaskGlyph state={task.state} attention={task.attention} size={22} /></div>
      <div className="grow">
        <div className="row" style={{ gap: 8 }}>
          <span className="task-title ellipsis">{task.title}</span>
        </div>
        {!compact && (
          <motion.div key={task.nowLine} className="task-now" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={fm.settle}>
            {done ? task.result : task.state === 'FAILED' ? task.error : task.nowLine}
          </motion.div>
        )}
        <div className="task-meta">
          <span className={`state-dot s-${task.state}`}>{TASK_LABEL[task.state] ?? task.state}</span>
          <span className="faint">·</span>
          <span className="faint tnum">{progressText(task)}</span>
          {!done && <StepPips task={task} />}
          {task.children?.length > 0 && <span className="chip" style={{ height: 22 }}>{task.children.filter((c) => c.state === 'COMPLETED').length}/{task.children.length} subtasks</span>}
          {task.verification && <span className={`chip ${task.verification.verdict === 'pass' ? 'settled' : task.verification.verdict === 'fail' ? 'attention' : ''}`} style={{ height: 22 }}>{task.verification.verdict === 'pass' ? 'Verified' : task.verification.verdict === 'fail' ? 'Review: issues' : 'Unreviewed'}</span>}
        </div>
      </div>
      {active && <motion.span className="activity-sheen" layoutId={`sheen-${task.id}`} />}
    </motion.button>
  );
}
