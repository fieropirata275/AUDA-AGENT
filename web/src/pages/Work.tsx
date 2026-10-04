/**
 * Work: everything AUDA is handling, organised by what it means for you.
 * One continuous surface — when a task changes state it physically moves
 * to its new section instead of disappearing from one tab and appearing in another.
 */
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { useStore } from '../lib/store';
import { useRoute, navigate } from '../lib/router';
import { Segmented, Empty } from '../components/controls';
import { TaskCard } from '../components/TaskCard';
import { ResponsibilityCard } from '../components/ResponsibilityCard';
import { ApprovalCard } from '../components/ApprovalCard';
import { RuleCard } from '../components/RuleCard';
import { fm } from '../motion/spring';
import { Morph } from '../motion/Morph';
import { until } from '../lib/time';
import { openSheet } from '../components/ui';
import type { ReactNode } from 'react';

type View = 'all' | 'needs' | 'progress' | 'watching' | 'scheduled' | 'recovering' | 'completed';

function Section({ title, n, children, icon }: { title: string; n: number; children: ReactNode; icon: string }) {
  return (
    <motion.section layout="position" className="section" transition={fm.glide}>
      <div className="section-head"><Morph shape={icon} size={16} color="var(--ink-3)" animate={false} /><h2>{title}</h2><span className="n">{n}</span></div>
      {children}
    </motion.section>
  );
}

export function Work() {
  const s = useStore();
  const { query } = useRoute();
  const view = (query.get('view') as View) ?? 'all';
  const tasks = Object.values(s.tasks);
  const approvals = Object.values(s.approvals).filter((a) => a.state === 'pending');
  const suggested = Object.values(s.rules).filter((r) => r.state === 'draft');
  const problems = tasks.filter((t) => t.state === 'WAITING_USER' && t.attention === 'problem' || t.state === 'FAILED' && (t.completedAt ?? 0) > Date.now() - 86400_000);
  const progress = tasks.filter((t) => ['RUNNING', 'READY', 'WAITING_EXTERNAL', 'PAUSED', 'PLANNING'].includes(t.state) || (t.state === 'WAITING_USER' && t.attention === 'approval')).sort((a, b) => b.updatedAt - a.updatedAt);
  const recovering = tasks.filter((t) => ['RETRYING', 'RECOVERING'].includes(t.state));
  const scheduledTasks = tasks.filter((t) => t.state === 'SCHEDULED').sort((a, b) => (a.nextEventAt ?? 0) - (b.nextEventAt ?? 0));
  const resps = Object.values(s.responsibilities).filter((r) => r.state !== 'ENDED').sort((a, b) => b.updatedAt - a.updatedAt);
  const recurring = resps.flatMap((r) => r.schedules.filter((x) => x.enabled && x.nextRunAt).map((x) => ({ ...x, resp: r }))).sort((a, b) => a.nextRunAt! - b.nextRunAt!);
  const completed = tasks.filter((t) => ['COMPLETED', 'CANCELLED', 'FAILED'].includes(t.state)).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  const ended = Object.values(s.responsibilities).filter((r) => r.state === 'ENDED');
  const show = (v: View) => view === 'all' || view === v;
  const needsN = approvals.length + suggested.length + problems.length;

  return (
    <div>
      <div className="page-head">
        <div><h1 className="title-lg">Work</h1><p>Everything AUDA is handling. It works quietly and only brings you what needs your judgment.</p></div>
      </div>
      <div className="work-filter">
        <Segmented id="work" value={view} onChange={(v) => navigate(v === 'all' ? '/work' : `/work?view=${v}`)} options={[
          { value: 'all', label: 'Everything' }, { value: 'needs', label: 'Needs you', count: needsN }, { value: 'progress', label: 'In progress', count: progress.length },
          { value: 'watching', label: 'Watching', count: resps.length }, { value: 'scheduled', label: 'Scheduled', count: scheduledTasks.length + recurring.length },
          { value: 'recovering', label: 'Recovering', count: recovering.length }, { value: 'completed', label: 'Completed' },
        ]} />
      </div>
      <LayoutGroup>
        {show('needs') && (needsN > 0 || view === 'needs') && (
          <Section title="Needs you" n={needsN} icon="attention">
            <div className="stack" style={{ gap: 14 }}>
              <AnimatePresence>{approvals.map((a) => <ApprovalCard key={a.id} a={a} />)}</AnimatePresence>
              {problems.map((t) => <TaskCard key={t.id} task={t} />)}
              {suggested.map((r) => <RuleCard key={r.id} rule={r} />)}
              {!needsN && <Empty title="Nothing needs you">AUDA will bring decisions here — specific ones, with a recommendation.</Empty>}
            </div>
          </Section>
        )}
        {show('progress') && (
          <Section title="In progress" n={progress.length} icon="orbit">
            <div className="stack"><AnimatePresence>{progress.map((t) => <TaskCard key={t.id} task={t} />)}</AnimatePresence>
              {!progress.length && <Empty title="Nothing in motion right now" />}</div>
          </Section>
        )}
        {show('recovering') && (recovering.length > 0 || view === 'recovering') && (
          <Section title="Recovering" n={recovering.length} icon="recover">
            <div className="stack"><AnimatePresence>{recovering.map((t) => <TaskCard key={t.id} task={t} />)}</AnimatePresence>
              {!recovering.length && <Empty title="Nothing to repair">When something fails, AUDA retries with backoff or resumes from its last checkpoint — and shows it here.</Empty>}</div>
          </Section>
        )}
        {show('watching') && (
          <Section title="Watching" n={resps.length} icon="eye">
            <div className="grid-2">{resps.map((r) => <ResponsibilityCard key={r.id} r={r} />)}</div>
            {!resps.length && <Empty title="No ongoing responsibilities">Ask AUDA to keep an eye on something.</Empty>}
          </Section>
        )}
        {show('scheduled') && (
          <Section title="Scheduled" n={scheduledTasks.length + recurring.length} icon="clock">
            <div className="schedule">
              {[...scheduledTasks.map((t) => ({ at: t.nextEventAt!, title: t.title, sub: 'One-time', onClick: () => openSheet({ type: 'task', id: t.id }) })),
                ...recurring.map((x) => ({ at: x.nextRunAt!, title: x.resp.title, sub: x.description, onClick: () => openSheet({ type: 'responsibility', id: x.resp.id }) }))]
                .sort((a, b) => a.at - b.at).map((x, i) => (
                  <motion.button key={i} layout className="sched-row" onClick={x.onClick} transition={fm.glide}>
                    <div className="sched-when"><span className="sched-day">{new Date(x.at).toLocaleDateString(undefined, { weekday: 'short' })}</span><span className="sched-time tnum">{new Date(x.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span></div>
                    <div className="grow"><div style={{ fontWeight: 560 }}>{x.title}</div><div className="small faint">{x.sub} · {until(x.at)}</div></div>
                  </motion.button>
                ))}
              {!scheduledTasks.length && !recurring.length && <Empty title="Nothing scheduled">Try “every Monday morning, summarise last week” or “remind me tomorrow at 9 to call the supplier”.</Empty>}
            </div>
          </Section>
        )}
        {show('completed') && (
          <Section title="Completed" n={completed.length} icon="check">
            <div className="stack">{completed.slice(0, view === 'completed' ? 100 : 6).map((t) => <TaskCard key={t.id} task={t} />)}</div>
            {view === 'all' && completed.length > 6 && <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => navigate('/work?view=completed')}>Show all {completed.length}</button>}
            {view === 'completed' && ended.length > 0 && <div style={{ marginTop: 24 }}><div className="label" style={{ marginBottom: 8 }}>Ended responsibilities</div><div className="grid-2">{ended.map((r) => <ResponsibilityCard key={r.id} r={r} compact />)}</div></div>}
          </Section>
        )}
      </LayoutGroup>
    </div>
  );
}
