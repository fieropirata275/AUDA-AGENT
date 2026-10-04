/** Detail sheets: progressive disclosure — simple first, everything inspectable. */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStore } from '../lib/store';
import { api, post } from '../lib/api';
import { Sheet, Tabs, Button } from './controls';
import { openSheet, useSheet } from './ui';
import { TaskGlyph, RespGlyph, TASK_LABEL, RESP_LABEL } from './glyphs';
import { Timeline } from './Timeline';
import { ApprovalCard } from './ApprovalCard';
import { Sparkline } from './Sparkline';
import { Markdown } from './Markdown';
import { progressText } from './TaskCard';
import { ago, until, bytes, clock } from '../lib/time';
import { Morph } from '../motion/Morph';
import { fm } from '../motion/spring';
import type { Artifact } from '../lib/types';
import { AssignWork } from './AssignWork';

function StepList({ steps, current, state }: { steps: any[]; current: number; state: string }) {
  return (
    <ol className="plan">
      {steps.map((s) => {
        const shape = s.state === 'done' ? 'check' : s.state === 'running' ? 'orbit' : s.state === 'waiting' ? 'attention' : s.state === 'failed' ? 'problem' : s.state === 'skipped' ? 'close' : 'rest';
        const color = s.state === 'done' ? 'var(--settled)' : s.state === 'running' ? 'var(--accent)' : s.state === 'waiting' ? 'var(--attention)' : s.state === 'failed' ? 'var(--problem)' : 'var(--ink-4)';
        return (
          <motion.li key={s.idx} layout className={`plan-step ${s.state} ${s.idx === current && !['COMPLETED', 'CANCELLED'].includes(state) ? 'current' : ''}`} transition={fm.settle}>
            <span className="plan-mark"><Morph shape={shape} size={16} color={color} /></span>
            <div className="grow">
              <div className="plan-title">{s.title}{s.attempts > 1 && <span className="chip attention" style={{ marginLeft: 8, height: 20 }}>attempt {s.attempts}</span>}</div>
              {s.narration && <div className="plan-note">{s.narration}</div>}
            </div>
            {s.endedAt && s.startedAt && <span className="faint small tnum">{Math.max(0.1, (s.endedAt - s.startedAt) / 1000).toFixed(1)}s</span>}
          </motion.li>
        );
      })}
    </ol>
  );
}

function TaskSheet({ id }: { id: string }) {
  const s = useStore();
  const t = s.tasks[id];
  const [detail, setDetail] = useState<any>(null);
  const [tab, setTab] = useState<'overview' | 'timeline' | 'hood'>('overview');
  useEffect(() => { api(`/api/tasks/${id}`).then(setDetail).catch(() => {}); }, [id, t?.updatedAt, t?.state]);
  const task = t ?? detail;
  if (!task) return <div className="sheet-body faint">Loading…</div>;
  const resp = task.responsibilityId ? s.responsibilities[task.responsibilityId] : null;
  const pending = Object.values(s.approvals).filter((a) => a.taskId === id && a.state === 'pending');
  const active = !['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.state);
  return (
    <>
      <div className="sheet-head">
        <div className="task-glyph lg"><TaskGlyph state={task.state} attention={task.attention} size={26} /></div>
        <div className="grow">
          <div className="faint small">{TASK_LABEL[task.state]} · {progressText(task)}</div>
          <h2 className="title" style={{ marginTop: 2 }}>{task.title}</h2>
        </div>
        <button className="btn ghost icon" onClick={() => openSheet(null)} aria-label="Close"><Morph shape="close" size={18} /></button>
      </div>
      <Tabs value={tab} onChange={setTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'timeline', label: 'Timeline' }, { value: 'hood', label: 'Under the hood' }]} />
      <div className="sheet-body">
        {tab === 'overview' && (
          <div className="stack" style={{ gap: 18 }}>
            {active && task.nowLine && <motion.p key={task.nowLine} className="now-voice" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>{task.nowLine}</motion.p>}
            {task.state === 'COMPLETED' && task.result && <div className="outcome"><Morph shape="check" size={18} color="var(--settled)" /><div>{task.result}</div></div>}
            {task.state === 'FAILED' && (
              <div className="trouble">
                <div className="title" style={{ fontSize: 16 }}>AUDA hit a problem</div>
                <p>{task.diagnosis ?? task.error}</p>
                <div className="row"><Button size="sm" variant="primary" icon="recover" onClick={() => post(`/api/tasks/${id}/resume`)}>Try again</Button><Button size="sm" onClick={() => location.assign('/computer')}>Open computer</Button></div>
              </div>
            )}
            {task.attention === 'problem' && task.state === 'WAITING_USER' && (
              <div className="trouble"><p style={{ marginTop: 0 }}>{task.error}</p><div className="row"><Button size="sm" onClick={() => post(`/api/tasks/${id}/resume`)}>Try again</Button><Button size="sm" variant="ghost" onClick={() => post(`/api/tasks/${id}/cancel`)}>Stop task</Button></div></div>
            )}
            <AnimatePresence>{pending.map((a) => <ApprovalCard key={a.id} a={a} />)}</AnimatePresence>
            {task.verification && (
              <div className={`review r-${task.verification.verdict}`}>
                <Morph shape={task.verification.verdict === 'pass' ? 'check' : task.verification.verdict === 'fail' ? 'attention' : 'dots'} size={18} color={task.verification.verdict === 'pass' ? 'var(--settled)' : 'var(--attention)'} animate={false} />
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{task.verification.verdict === 'pass' ? 'Independently reviewed — meets the criteria' : task.verification.verdict === 'fail' ? `Review found issues${active ? ' — AUDA is fixing them' : ''}` : 'Not reviewed'}</div>
                  <div className="small muted">{task.verification.summary}{task.verification.round > 1 ? ` · review round ${task.verification.round}` : ''}</div>
                  {task.verification.issues?.length > 0 && <ul className="small">{task.verification.issues.map((i: string, k: number) => <li key={k}>{i}</li>)}</ul>}
                </div>
              </div>
            )}
            <dl className="kv">
              {task.goal && task.goal !== task.title && <><dt>Goal</dt><dd>{task.goal}</dd></>}
              {task.criteria && <><dt>Done when</dt><dd>{task.criteria}</dd></>}
              <dt>Why it exists</dt>
              <dd>{task.parentTaskId ? <button className="link" onClick={() => openSheet({ type: 'task', id: task.parentTaskId! })}>Subtask of “{s.tasks[task.parentTaskId]?.title ?? 'a larger task'}”</button> : resp ? <button className="link" onClick={() => openSheet({ type: 'responsibility', id: resp.id })}>Part of “{resp.title}”</button> : task.origin?.type === 'chat' ? 'You asked in chat' : task.origin?.type === 'user' ? 'You created it' : 'AUDA started it'}</dd>
              <dt>Started</dt><dd>{task.startedAt ? `${ago(task.startedAt)} · ${clock(task.startedAt)}` : task.nextEventAt ? until(task.nextEventAt) : 'Not yet'}</dd>
              {task.retryCount > 0 && <><dt>Retries</dt><dd>{task.retryCount} of {task.maxRetries}</dd></>}
            </dl>
            <div>
              <div className="label" style={{ marginBottom: 8 }}>Plan</div>
              {task.playbook === 'agent'
                ? (task.plan?.length ? <StepList steps={task.plan.map((p: any, i: number) => ({ idx: i, title: p.title, state: p.status === 'doing' ? 'running' : p.status === 'done' ? 'done' : p.status === 'skipped' ? 'skipped' : 'pending', attempts: 1 }))} current={-1} state={task.state} />
                  : <div className="small faint">{active ? 'AUDA hasn’t published a plan yet.' : 'No plan was needed.'}</div>)
                : <StepList steps={task.steps} current={task.currentStep} state={task.state} />}
            </div>
            {task.children?.length > 0 && (
              <div>
                <div className="label" style={{ marginBottom: 8 }}>Sub-agents working on parts of this</div>
                <div className="stack">{task.children.map((c: any) => (
                  <button key={c.id} className="hist-row" onClick={() => openSheet({ type: 'task', id: c.id })}>
                    <TaskGlyph state={c.state} size={18} /><div className="grow" style={{ textAlign: 'left' }}><div style={{ fontWeight: 550 }}>{c.title}</div><div className="small faint">{s.tasks[c.id]?.result ?? s.tasks[c.id]?.nowLine ?? TASK_LABEL[c.state]}</div></div>
                  </button>
                ))}</div>
              </div>
            )}
            {detail?.artifacts?.length > 0 && (
              <div>
                <div className="label" style={{ marginBottom: 8 }}>What it produced</div>
                <div className="stack">{detail.artifacts.map((a: Artifact) => <ArtifactRow key={a.id} a={a} />)}</div>
              </div>
            )}
            {active && (
              <div className="row" style={{ gap: 8, marginTop: 6 }}>
                {task.state === 'PAUSED' ? <Button size="sm" icon="play" onClick={() => post(`/api/tasks/${id}/resume`)}>Resume</Button>
                  : <Button size="sm" icon="pause" onClick={() => post(`/api/tasks/${id}/pause`)}>Pause</Button>}
                <Button size="sm" variant="ghost" className="danger" onClick={() => post(`/api/tasks/${id}/cancel`)}>Stop task</Button>
              </div>
            )}
          </div>
        )}
        {tab === 'timeline' && <Timeline items={[...(detail?.activity ?? [])].reverse()} showLinks={false} groupByDay={false} />}
        {tab === 'hood' && detail && (
          <div className="stack" style={{ gap: 18 }}>
            <dl className="kv small">
              <dt>Task id</dt><dd className="mono">{detail.id}</dd>
              <dt>Playbook</dt><dd className="mono">{detail.playbook}</dd>
              <dt>State</dt><dd className="mono">{detail.state}</dd>
              <dt>Model cost</dt><dd>{detail.cost ? `$${detail.cost.toFixed(4)}` : 'none'}</dd>
              <dt>Crash recoveries</dt><dd>{detail.recoveries}</dd>
              <dt>Depth</dt><dd>{detail.depth === 0 ? 'top-level' : `sub-agent (level ${detail.depth})`}</dd>
            </dl>
            <div><div className="label">Actions & authority (audit)</div>
              <table className="table small"><tbody>{detail.audit.map((x: any) => <tr key={x.id}><td className="tnum faint">{clock(x.ts)}</td><td className="mono">{x.capability}</td><td>{x.detail}</td><td><span className={`chip ${x.result === 'ok' ? 'settled' : x.result === 'deduplicated' ? '' : 'problem'}`}>{x.decision.split(':')[0]}</span></td></tr>)}</tbody></table>
              {!detail.audit.length && <div className="faint small">No side effects yet — only reading.</div>}
            </div>
            {detail.playbook === 'agent' && <div><div className="label">Turns</div><StepList steps={detail.steps} current={detail.currentStep} state={detail.state} /></div>}
            <div><div className="label">Runs (durable execution)</div>
              <table className="table small"><tbody>{detail.runs.map((r: any, i: number) => <tr key={i}><td>#{r.attempt}</td><td className="mono">{r.worker_id}</td><td>{r.outcome ?? r.state}</td><td className="faint">{r.error}</td></tr>)}</tbody></table>
            </div>
            {detail.models.length > 0 && <div><div className="label">Model calls</div>
              <table className="table small"><tbody>{detail.models.map((m: any, i: number) => <tr key={i}><td className="mono">{m.model}</td><td>{m.purpose}</td><td className="tnum">{m.input_tokens}→{m.output_tokens}</td></tr>)}</tbody></table></div>}
            <div><div className="label">Input</div><pre className="raw mono">{JSON.stringify(detail.input, null, 2)}</pre></div>
            <div><div className="label">Step outputs</div><pre className="raw mono">{JSON.stringify(detail.stepOutputs.filter((x: any) => x.output), null, 2)}</pre></div>
          </div>
        )}
      </div>
    </>
  );
}

function ArtifactRow({ a }: { a: Artifact }) {
  return (
    <button className="artifact-row" onClick={() => openSheet({ type: 'artifact', id: a.id })}>
      <span className="file-ico">{a.mime.startsWith('image') ? 'IMG' : a.name.split('.').pop()?.toUpperCase()}</span>
      <div className="grow" style={{ textAlign: 'left' }}><div className="ellipsis" style={{ fontWeight: 550 }}>{a.name}</div><div className="small faint ellipsis">{a.why}</div></div>
      <span className="small faint">{bytes(a.size)}</span>
    </button>
  );
}
export { ArtifactRow };

function RespSheet({ id }: { id: string }) {
  const s = useStore();
  const r = s.responsibilities[id];
  const [tab, setTab] = useState<'overview' | 'history'>('overview');
  if (!r) return null;
  const tasks = Object.values(s.tasks).filter((t) => t.responsibilityId === id).sort((a, b) => b.createdAt - a.createdAt);
  const acts = Object.values(s.activity).filter((a) => a.responsibilityId === id).sort((a, b) => b.ts - a.ts);
  return (
    <>
      <div className="sheet-head">
        <div className="task-glyph lg"><RespGlyph state={r.state} size={26} /></div>
        <div className="grow"><div className="faint small">Responsibility · {RESP_LABEL[r.state]} · since {new Date(r.createdAt).toLocaleDateString()}</div><h2 className="title" style={{ marginTop: 2 }}>{r.title}</h2></div>
        <button className="btn ghost icon" onClick={() => openSheet(null)} aria-label="Close"><Morph shape="close" size={18} /></button>
      </div>
      <Tabs value={tab} onChange={setTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'history', label: `History · ${tasks.length}` }]} />
      <div className="sheet-body">
        {tab === 'overview' && (
          <div className="stack" style={{ gap: 18 }}>
            {r.description && <p className="now-voice" style={{ fontSize: 20 }}>{r.description}</p>}
            <p className="muted" style={{ margin: 0 }}>{r.statusLine}</p>
            <div>
              <div className="label" style={{ marginBottom: 8 }}>How AUDA notices</div>
              <div className="stack">
                {r.watchers.map((w) => (
                  <div key={w.id} className="well" style={{ padding: '12px 14px' }}>
                    <div className="row"><Morph shape="eye" size={16} color="var(--ink-3)" /><span className="grow">{w.description}</span><span className="small faint">every {w.intervalSec < 60 ? `${w.intervalSec}s` : w.intervalSec < 3600 ? `${Math.round(w.intervalSec / 60)} min` : `${Math.round(w.intervalSec / 3600)} h`}</span></div>
                    <div className="row" style={{ marginTop: 6 }}><span className="tnum">{w.lastValue ?? 'Waiting for first check'}</span><span className="grow" /><span className="small faint">{w.lastCheckedAt ? `checked ${ago(w.lastCheckedAt)}` : ''}</span></div>
                    {w.history && <div style={{ marginTop: 8 }}><Sparkline points={w.history} threshold={r.config.thresholdPct} width={500} height={44} /></div>}
                    {w.errors > 0 && <div className="chip problem" style={{ marginTop: 8 }}>{w.errors} failed checks — backing off</div>}
                  </div>
                ))}
                {r.schedules.map((sc) => <div key={sc.id} className="well row" style={{ padding: '12px 14px' }}><Morph shape="clock" size={16} color="var(--ink-3)" /><span className="grow">{sc.description}</span><span className="small faint">{sc.enabled ? `next ${until(sc.nextRunAt)}` : 'off'}</span></div>)}
                {r.triggers.map((tr: any) => <div key={tr.id} className="well row" style={{ padding: '12px 14px' }}><Morph shape="flow" size={16} color="var(--ink-3)" /><span className="grow">{tr.description}</span><span className="small mono faint">{tr.event_pattern}</span></div>)}
              </div>
            </div>
            {r.lastOutcome && <div><div className="label" style={{ marginBottom: 6 }}>Last outcome</div><div className="outcome"><Morph shape="check" size={16} color="var(--settled)" /><div>{r.lastOutcome}</div></div></div>}
            <dl className="kv small">
              <dt>Woken</dt><dd>{r.triggerCount} time{r.triggerCount === 1 ? '' : 's'}{r.lastTriggeredAt ? `, last ${ago(r.lastTriggeredAt)}` : ''}</dd>
              <dt>Playbook</dt><dd>{s.playbooks.find((p) => p.id === r.playbook)?.title ?? r.playbook}</dd>
            </dl>
            {r.state !== 'ENDED' && (
              <div className="row wrap" style={{ gap: 8 }}>
                <Button size="sm" icon="eye" onClick={() => post(`/api/responsibilities/${id}/check`)}>Check now</Button>
                {r.state === 'PAUSED' ? <Button size="sm" icon="play" onClick={() => post(`/api/responsibilities/${id}/resume`)}>Resume</Button> : <Button size="sm" icon="pause" onClick={() => post(`/api/responsibilities/${id}/pause`)}>Pause</Button>}
                <Button size="sm" variant="ghost" className="danger" onClick={() => post(`/api/responsibilities/${id}/end`)}>Stop being responsible</Button>
              </div>
            )}
          </div>
        )}
        {tab === 'history' && (
          <div className="stack" style={{ gap: 18 }}>
            <div className="stack">{tasks.map((t) => (
              <button key={t.id} className="hist-row" onClick={() => openSheet({ type: 'task', id: t.id })}>
                <TaskGlyph state={t.state} attention={t.attention} size={18} />
                <div className="grow" style={{ textAlign: 'left' }}><div style={{ fontWeight: 550 }}>{t.title}</div><div className="small faint">{t.result ?? t.nowLine}</div></div>
                <span className="small faint">{ago(t.createdAt)}</span>
              </button>
            ))}</div>
            <Timeline items={acts} showLinks />
          </div>
        )}
      </div>
    </>
  );
}

function ArtifactSheet({ id }: { id: string }) {
  const s = useStore();
  const a = s.artifacts[id];
  const [text, setText] = useState<string | null>(null);
  useEffect(() => { if (a && !a.mime.startsWith('image')) fetch(`/api/artifacts/${id}/raw`).then((r) => r.text()).then(setText); }, [id, a]);
  if (!a) return null;
  return (
    <>
      <div className="sheet-head">
        <span className="file-ico lg">{a.mime.startsWith('image') ? 'IMG' : a.name.split('.').pop()?.toUpperCase()}</span>
        <div className="grow"><div className="faint small">{a.path}</div><h2 className="title" style={{ marginTop: 2 }}>{a.name}</h2></div>
        <a className="btn ghost sm" href={`/api/artifacts/${id}/raw`} download={a.name}>Download</a>
        <button className="btn ghost icon" onClick={() => openSheet(null)} aria-label="Close"><Morph shape="close" size={18} /></button>
      </div>
      <div className="sheet-body">
        <div className="why"><span className="label">Why this file exists</span><div>{a.why}</div>
          {a.taskId && <button className="link small" onClick={() => openSheet({ type: 'task', id: a.taskId! })}>Made by “{a.taskTitle ?? 'a task'}” · {ago(a.createdAt)}</button>}</div>
        {a.mime.startsWith('image') ? <img src={`/api/artifacts/${id}/raw`} alt={a.name} className="artifact-img" />
          : a.mime === 'text/markdown' ? <Markdown text={text ?? ''} /> : <pre className="raw mono">{text}</pre>}
      </div>
    </>
  );
}

export function Sheets() {
  const sheet = useSheet();
  return (
    <Sheet open={!!sheet} onClose={() => openSheet(null)}>
      {sheet?.type === 'task' && <TaskSheet key={sheet.id} id={sheet.id} />}
      {sheet?.type === 'responsibility' && <RespSheet key={sheet.id} id={sheet.id} />}
      {sheet?.type === 'artifact' && <ArtifactSheet key={sheet.id} id={sheet.id} />}
      {sheet?.type === 'assign' && <AssignWork />}
    </Sheet>
  );
}
