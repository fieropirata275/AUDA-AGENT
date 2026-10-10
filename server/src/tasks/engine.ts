/**
 * Durable Task Engine.
 *
 * Tasks are persisted state machines. Workers claim READY tasks atomically,
 * hold a heartbeated lease, run one step at a time and checkpoint after every
 * step. A crash loses at most the step in flight; the supervisor detects the
 * expired lease and the task resumes from its checkpoint.
 */
import os from 'node:os';
import * as Proxmox from '../connectors/proxmox.ts';
import { insert, json, now, q, tx, uid, update, type Row } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { emit, on } from '../core/bus.ts';
import { activity } from '../core/activity.ts';
import { log } from '../core/log.ts';
import { playbook, type StepCtx, type StepResult } from '../playbooks/types.ts';
import { call } from '../tools/broker.ts';
import { ApprovalRejected, NeedsApproval, PolicyDenied, StepTimeout, UncertainAction, classify, diagnose } from '../tools/errors.ts';
import { HumanHasControl } from '../computer/index.ts';
import { saveArtifact } from '../artifacts/store.ts';
import { recall, remember } from '../memory/service.ts';
import { notify, type NotifyLevel } from '../notifications/service.ts';
import { decide } from '../policy/engine.ts';
import { capabilities } from '../policy/capabilities.ts';
import { BudgetExceeded } from '../models/router.ts';
import { hash } from '../core/db.ts';
import { currentUserId, runAs, OWNER_ID } from '../core/context.ts';

export const WORKER_ID = `${os.hostname()}:${process.pid}:${uid('w').slice(2, 8)}`;
const LEASE_MS = 30_000;
const POISON_THRESHOLD = 3;
const DEFAULT_STEP_TIMEOUT = Number(process.env.AUDA_STEP_TIMEOUT_MS ?? 10 * 60_000);
const HEARTBEAT_MS = 5_000;

export const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
export const ACTIVE = ['PLANNING', 'READY', 'RUNNING', 'WAITING_EXTERNAL', 'WAITING_USER', 'SCHEDULED', 'PAUSED', 'RETRYING', 'RECOVERING'];

const running = new Map<string, { runId: string; stop: boolean }>();
let concurrency = 3;
let timer: NodeJS.Timeout | null = null;

// ─── creation ────────────────────────────────────────────────────────────────

export interface CreateTask {
  title: string;
  goal?: string;
  playbook: string;
  input?: Record<string, any>;
  responsibilityId?: string;
  spaceId?: string | null;
  parentTaskId?: string;
  origin?: Record<string, any>;
  runAt?: number;
  priority?: number;
  deadlineAt?: number;
  ownerId?: string;
  agentId?: string;
}

export function createTask(t: CreateTask): string {
  const pb = playbook(t.playbook);
  const plan = pb.plan(t.input ?? {});
  const id = uid('task');
  const ts = now();
  const parent = t.parentTaskId ? q.get('SELECT depth, owner_id, agent_id FROM tasks WHERE id = ?', t.parentTaskId) : undefined;
  const depth = parent ? (parent.depth ?? 0) + 1 : 0;
  const ownerId = t.ownerId ?? parent?.owner_id ?? currentUserId();
  const agentId = t.agentId ?? parent?.agent_id ?? undefined;
  const scheduled = t.runAt && t.runAt > ts + 1000;
  tx(() => {
    insert('tasks', {
      id, title: t.title, goal: t.goal, playbook: t.playbook, input_json: JSON.stringify(t.input ?? {}),
      responsibility_id: t.responsibilityId, space_id: t.spaceId ?? undefined, parent_task_id: t.parentTaskId,
      origin_json: JSON.stringify(t.origin ?? {}), state: scheduled ? 'SCHEDULED' : 'READY',
      next_event_at: scheduled ? t.runAt : undefined, step_count: plan.length, priority: t.priority ?? 2,
      deadline_at: t.deadlineAt, depth, owner_id: ownerId, agent_id: agentId, now_line: scheduled ? `Scheduled for ${new Date(t.runAt!).toLocaleString()}` : 'Getting ready',
      created_at: ts, updated_at: ts,
    });
    plan.forEach((s, idx) => insert('task_steps', { id: uid('step'), task_id: id, idx, key: s.key, title: s.title, state: 'pending' }));
  });
  changed('task', id);
  activity(scheduled ? 'schedule' : 'reason', scheduled ? `Scheduled: ${t.title}` : `Started a task: ${t.title}`, {
    detail: t.goal, taskId: id, responsibilityId: t.responsibilityId, spaceId: t.spaceId,
  });
  emit('task.created', { subjectType: 'task', subjectId: id, payload: { playbook: t.playbook, responsibilityId: t.responsibilityId } });
  kick();
  return id;
}

// ─── state transitions ───────────────────────────────────────────────────────

function setState(id: string, state: string, patch: Row = {}) {
  update('tasks', id, { state, updated_at: now(), ...patch });
  changed('task', id);
}

export function cancelTask(id: string, why = 'Cancelled by you') {
  const t = q.get('SELECT * FROM tasks WHERE id = ?', id);
  if (!t || TERMINAL.includes(t.state)) return;
  const r = running.get(id); if (r) r.stop = true;
  setState(id, 'CANCELLED', { completed_at: now(), now_line: why, attention: null, result_summary: why });
  q.run("UPDATE approvals SET state = 'expired' WHERE task_id = ? AND state = 'pending'", id);
  for (const a of q.all('SELECT id FROM approvals WHERE task_id = ?', id)) changed('approval', a.id);
  activity('user', `Stopped: ${t.title}`, { taskId: id, responsibilityId: t.responsibility_id, spaceId: t.space_id });
  // Stopping a task stops the sub-agents working for it.
  for (const c of q.all(`SELECT id FROM tasks WHERE parent_task_id = ? AND state NOT IN ('COMPLETED','FAILED','CANCELLED')`, id)) cancelTask(c.id, 'Parent task was stopped');
  emit('task.cancelled', { subjectType: 'task', subjectId: id, payload: { responsibilityId: t.responsibility_id } });
}

export function pauseTask(id: string) {
  const t = q.get('SELECT * FROM tasks WHERE id = ?', id);
  if (!t || TERMINAL.includes(t.state) || t.state === 'PAUSED') return;
  const r = running.get(id); if (r) r.stop = true;
  setState(id, 'PAUSED', { now_line: 'Paused by you', waiting_on: t.state });
  activity('user', `Paused: ${t.title}`, { taskId: id, responsibilityId: t.responsibility_id });
}

export function resumeTask(id: string) {
  const t = q.get('SELECT * FROM tasks WHERE id = ?', id);
  if (!t || !['PAUSED', 'FAILED', 'WAITING_USER', 'WAITING_EXTERNAL'].includes(t.state)) return;
  if (t.state === 'WAITING_USER' && t.attention === 'approval') return; // needs a decision, not a resume
  setState(id, 'READY', { now_line: 'Resuming', attention: null, waiting_on: null, error: null, diagnosis: null, ...(t.state === 'FAILED' ? { retry_count: 0, completed_at: null, recoveries: 0 } : {}) });
  activity('user', `Resumed: ${t.title}`, { taskId: id, responsibilityId: t.responsibility_id });
  emit('task.resumed', { subjectType: 'task', subjectId: id });
  kick();
}

// ─── approvals ───────────────────────────────────────────────────────────────

export function decideApproval(id: string, decision: 'approved' | 'rejected', channel = 'web') {
  const a = q.get('SELECT * FROM approvals WHERE id = ?', id);
  if (!a || a.state !== 'pending') return a;
  update('approvals', id, { state: decision, decided_at: now(), decision_channel: channel });
  changed('approval', id);
  const t = q.get('SELECT * FROM tasks WHERE id = ?', a.task_id);
  activity('user', decision === 'approved' ? `You approved: ${a.title.replace(/\?$/, '')}` : `You declined: ${a.title.replace(/\?$/, '')}`, {
    taskId: a.task_id, responsibilityId: t?.responsibility_id, spaceId: t?.space_id,
  });
  emit(decision === 'approved' ? 'approval.granted' : 'approval.rejected', { subjectType: 'approval', subjectId: id, payload: { taskId: a.task_id } });
  if (t && t.state === 'WAITING_USER') {
    setState(t.id, 'READY', { attention: null, now_line: decision === 'approved' ? 'Approved — continuing' : 'Understood — adjusting the plan' });
    kick();
  }
  return q.get('SELECT * FROM approvals WHERE id = ?', id);
}

// ─── worker loop ─────────────────────────────────────────────────────────────

export function startEngine(opts: { concurrency?: number } = {}) {
  concurrency = opts.concurrency ?? 3;
  // Any lease held by a previous process is dead by definition.
  for (const r of q.all("SELECT * FROM task_runs WHERE state = 'running' AND worker_id != ?", WORKER_ID)) abandonRun(r, 'AUDA restarted while this was running');
  timer = setInterval(tick, 500);
  // Orchestration: when every child of a waiting parent is finished, wake the parent.
  const childDone = (e: { payload: Record<string, any>; subjectId?: string }) => {
    const child = q.get('SELECT parent_task_id FROM tasks WHERE id = ?', e.subjectId);
    if (child?.parent_task_id) wakeParentIfDone(child.parent_task_id);
  };
  on('task.completed', childDone); on('task.failed', childDone); on('task.cancelled', childDone);
  on('computer.control.changed', (e) => {
    if (e.payload.controller !== 'auda') return;
    for (const t of q.all("SELECT id FROM tasks WHERE state = 'WAITING_EXTERNAL' AND waiting_on = 'computer'")) {
      setState(t.id, 'READY', { waiting_on: null, now_line: 'Computer is back — continuing' });
    }
    kick();
  });
}
export function wakeParentIfDone(parentId: string) {
  const parent = q.get('SELECT * FROM tasks WHERE id = ?', parentId);
  if (!parent || parent.state !== 'WAITING_EXTERNAL' || parent.waiting_on !== 'children') return;
  const open = q.get(`SELECT COUNT(*) n FROM tasks WHERE parent_task_id = ? AND state NOT IN ('COMPLETED','FAILED','CANCELLED')`, parentId)!.n;
  if (open) { update('tasks', parentId, { now_line: `Waiting for ${open} subtask${open > 1 ? 's' : ''}` }); changed('task', parentId); return; }
  setState(parentId, 'READY', { waiting_on: null, next_event_at: null, now_line: 'Subtasks finished — combining results' });
  kick();
}

export function stopEngine() { if (timer) clearInterval(timer); for (const r of running.values()) r.stop = true; }

let kicked = false;
export function kick() { if (!kicked) { kicked = true; setImmediate(() => { kicked = false; tick(); }); } }

function tick() {
  const free = concurrency - running.size;
  if (free <= 0) return;
  const t = now();
  const candidates = q.all(
    `SELECT id, state FROM tasks WHERE state = 'READY'
       OR (state IN ('SCHEDULED','RETRYING','WAITING_EXTERNAL') AND next_event_at IS NOT NULL AND next_event_at <= ?)
     ORDER BY priority ASC, created_at ASC LIMIT ?`, t, free);
  for (const c of candidates) {
    const res = q.run("UPDATE tasks SET state = 'RUNNING', updated_at = ? WHERE id = ? AND state = ?", now(), c.id, c.state);
    if (res.changes !== 1) continue;
    // Each task runs as the person it belongs to: their plugin connections, their memory.
    const owner = q.get('SELECT owner_id FROM tasks WHERE id = ?', c.id)?.owner_id ?? OWNER_ID;
    void runAs(owner, () => runTask(c.id, c.state));
  }
}

// ─── execution ───────────────────────────────────────────────────────────────

async function runTask(id: string, fromState: string) {
  const task0 = q.get('SELECT * FROM tasks WHERE id = ?', id)!;
  const attempt = (q.get('SELECT COUNT(*) n FROM task_runs WHERE task_id = ?', id)?.n ?? 0) + 1;
  const runId = uid('run');
  insert('task_runs', { id: runId, task_id: id, attempt, state: 'running', worker_id: WORKER_ID, lease_expires_at: now() + LEASE_MS, heartbeat_at: now(), started_at: now() });
  const handle = { runId, stop: false };
  running.set(id, handle);
  const hb = setInterval(() => q.run('UPDATE task_runs SET heartbeat_at = ?, lease_expires_at = ? WHERE id = ?', now(), now() + LEASE_MS, runId), HEARTBEAT_MS);
  update('tasks', id, { started_at: task0.started_at ?? now(), next_event_at: null, waiting_on: null });
  changed('task', id);
  if (fromState === 'SCHEDULED' || fromState === 'READY' && task0.current_step === 0 && attempt === 1) {
    emit('task.started', { subjectType: 'task', subjectId: id, payload: { responsibilityId: task0.responsibility_id } });
  }

  let outcome = 'ended';
  try {
    const pb = playbook(task0.playbook);
    while (true) {
      if (handle.stop) { outcome = 'stopped'; break; }
      const task = q.get('SELECT * FROM tasks WHERE id = ?', id)!;
      if (task.state !== 'RUNNING') { outcome = 'stopped'; break; }
      const step = q.get('SELECT * FROM task_steps WHERE task_id = ? AND idx = ?', id, task.current_step);
      if (!step) { finish(task, task.result_summary ?? 'Done'); break; }
      const fn = pb.steps[step.key];
      if (!fn) throw new Error(`Playbook ${pb.id} has no step ${step.key}`);

      // Resuming after a pause (approval, computer hand-back) is not a new attempt.
      update('task_steps', step.id, { state: 'running', started_at: step.started_at ?? now(), attempts: step.state === 'waiting' ? Math.max(1, step.attempts) : step.attempts + 1 });
      update('tasks', id, { now_line: step.title, updated_at: now() });
      changed('task', id);

      const vars = json<Record<string, any>>(task.checkpoint_json, {});
      const abort = new AbortController();
      const ctx = makeCtx(task, step.idx, vars, abort.signal);
      const budget = pb.stepTimeoutMs?.[step.key] ?? DEFAULT_STEP_TIMEOUT;
      let result: StepResult;
      let timer: NodeJS.Timeout | undefined;
      try {
        // A hung step must not hold its lease forever: race it against its time budget.
        result = await Promise.race([
          fn(ctx),
          new Promise<never>((_, rej) => { timer = setTimeout(() => { abort.abort(); rej(new StepTimeout(`“${step.title}” took longer than ${Math.round(budget / 60000) || 1} min`)); }, budget); }),
        ]);
        clearTimeout(timer);
      } catch (e) {
        clearTimeout(timer);
        const handled = handleStepError(task, step, e, vars);
        outcome = handled;
        break;
      }
      if (handle.stop) { outcome = 'stopped'; break; }

      // Checkpoint: step output + vars + cursor, atomically.
      const r = (result ?? {}) as any;
      tx(() => {
        update('task_steps', step.id, { state: 'done', ended_at: now(), output_json: r.output === undefined ? undefined : JSON.stringify(r.output), narration: r.narration });
        if (r.insert) {
          const after = q.all('SELECT id, idx FROM task_steps WHERE task_id = ? AND idx > ? ORDER BY idx DESC', id, step.idx);
          for (const s of after) q.run('UPDATE task_steps SET idx = ? WHERE id = ?', s.idx + r.insert.length, s.id);
          r.insert.forEach((s: any, i: number) => insert('task_steps', { id: uid('step'), task_id: id, idx: step.idx + 1 + i, key: s.key, title: s.title, state: 'pending' }));
        }
        const count = q.get('SELECT COUNT(*) n FROM task_steps WHERE task_id = ?', id)!.n;
        update('tasks', id, { checkpoint_json: JSON.stringify(vars), current_step: step.idx + 1, step_count: count, retry_count: 0, updated_at: now() });
      });
      changed('task', id);
      emit('task.step.completed', { subjectType: 'task', subjectId: id, payload: { step: step.key } });

      if (r.complete) {
        q.run("UPDATE task_steps SET state = 'skipped' WHERE task_id = ? AND state = 'pending'", id);
        finish(q.get('SELECT * FROM tasks WHERE id = ?', id)!, r.complete);
        break;
      }
      if (r.wait === 'external') {
        setState(id, 'WAITING_EXTERNAL', { next_event_at: r.until ?? null, now_line: r.reason, waiting_on: r.on ?? 'external' });
        activity('wait', r.reason, { taskId: id, responsibilityId: task.responsibility_id, spaceId: task.space_id });
        emit('task.waiting', { subjectType: 'task', subjectId: id, payload: { on: 'external' } });
        outcome = 'waiting';
        if (r.on === 'children') wakeParentIfDone(id); // children may already be done
        break;
      }
    }
  } catch (e) {
    log.error(`task ${id} crashed`, e);
    const task = q.get('SELECT * FROM tasks WHERE id = ?', id)!;
    const step = q.get('SELECT * FROM task_steps WHERE task_id = ? AND idx = ?', id, task.current_step);
    outcome = handleStepError(task, step, e, json(task.checkpoint_json, {}));
  } finally {
    clearInterval(hb);
    running.delete(id);
    q.run("UPDATE task_runs SET state = 'ended', ended_at = ?, outcome = ? WHERE id = ?", now(), outcome, runId);
    // Park dedicated agent VMs only when no other active execution uses the same agent.
    // Never suspend on WAITING_USER or pending retries: the guest may be needed at resume.
    const finalTask = q.get('SELECT agent_id, state FROM tasks WHERE id = ?', id);
    if (Proxmox.isEnabled() && finalTask?.agent_id && TERMINAL.includes(finalTask.state)) {
      const other = q.get("SELECT COUNT(*) n FROM tasks WHERE agent_id = ? AND id != ? AND state = 'RUNNING'", finalTask.agent_id, id)?.n ?? 0;
      if (!other) {
        try { await Proxmox.parkIfIdle(finalTask.agent_id); }
        catch (e) { log.warn('Could not suspend agent VM', String(e)); }
      }
    }
    kick();
  }
}

function finish(task: Row, summary: string) {
  setState(task.id, 'COMPLETED', { completed_at: now(), result_summary: summary, now_line: summary, attention: null });
  activity('complete', `Finished: ${task.title}`, { detail: summary, taskId: task.id, responsibilityId: task.responsibility_id, spaceId: task.space_id });
  emit('task.completed', { subjectType: 'task', subjectId: task.id, payload: { responsibilityId: task.responsibility_id, summary } });
}

function handleStepError(task: Row, step: Row | undefined, e: unknown, vars: Record<string, any>): string {
  const meta = { taskId: task.id, responsibilityId: task.responsibility_id, spaceId: task.space_id };
  update('tasks', task.id, { checkpoint_json: JSON.stringify(vars) });
  if (e instanceof NeedsApproval) {
    if (step) update('task_steps', step.id, { state: 'waiting' });
    setState(task.id, 'WAITING_USER', { attention: 'approval', now_line: `Waiting for you: ${e.title}` });
    emit('task.waiting', { subjectType: 'task', subjectId: task.id, payload: { on: 'user', approvalId: e.approvalId } });
    return 'waiting_user';
  }
  if (e instanceof HumanHasControl) {
    if (step) update('task_steps', step.id, { state: 'waiting' });
    setState(task.id, 'WAITING_EXTERNAL', { waiting_on: 'computer', now_line: 'Waiting for you to hand back the computer', next_event_at: null });
    activity('wait', 'Paused while you have the computer', { ...meta, detail: `“${task.title}” continues when you return control.` });
    return 'waiting_computer';
  }
  if (e instanceof PolicyDenied || e instanceof UncertainAction || e instanceof BudgetExceeded || e instanceof ApprovalRejected) {
    if (step) update('task_steps', step.id, { state: 'failed', ended_at: now(), narration: (e as Error).message });
    const msg = e instanceof UncertainAction
      ? `${(e as Error).message}. I won’t repeat it without you checking first.`
      : (e as Error).message;
    setState(task.id, 'WAITING_USER', { attention: 'problem', error: msg, now_line: msg });
    activity('problem', `Blocked: ${task.title}`, { ...meta, detail: msg });
    notify('blocked', `AUDA is blocked on “${task.title}”`, msg, { type: 'task', id: task.id });
    emit('task.waiting', { subjectType: 'task', subjectId: task.id, payload: { on: 'user', problem: true } });
    return 'blocked';
  }
  // Everything else: classify. Permanent failures stop immediately with a diagnosis;
  // transient and unknown ones retry with exponential backoff and jitter, then fail honestly.
  const cls = classify(e);
  const retries = task.retry_count + 1;
  const message = (e as Error)?.message ?? String(e);
  const limit = cls === 'transient' ? task.max_retries + 2 : task.max_retries;
  if (cls !== 'permanent' && retries <= limit) {
    const delay = Math.min(300_000, 2000 * 2 ** (retries - 1)) * (0.8 + Math.random() * 0.4);
    if (step) update('task_steps', step.id, { state: 'pending', narration: message });
    setState(task.id, 'RETRYING', { retry_count: retries, error: message, next_event_at: now() + delay, now_line: `Hit a ${cls === 'transient' ? 'temporary ' : ''}problem; trying again in ${Math.round(delay / 1000)}s` });
    activity('recover', `Retrying “${step?.title ?? task.title}”`, { ...meta, detail: `${message} — attempt ${retries + 1} of ${limit + 1} in ${Math.round(delay / 1000)}s.`, raw: { class: cls, stack: (e as Error)?.stack } });
    return 'retrying';
  }
  const diagnosis = diagnose(e, cls, `Stopped at “${step?.title ?? 'a step'}”`);
  if (step) update('task_steps', step.id, { state: 'failed', ended_at: now(), narration: message });
  setState(task.id, 'FAILED', { error: message, diagnosis, completed_at: now(), now_line: 'AUDA hit a problem it couldn’t recover from', attention: 'problem' });
  activity('problem', `AUDA hit a problem: ${task.title}`, { ...meta, detail: `${diagnosis}\nNothing after “${step?.title ?? 'this step'}” was done.`, raw: { class: cls, stack: (e as Error)?.stack } });
  notify('attention', `AUDA hit a problem with “${task.title}”`, diagnosis, { type: 'task', id: task.id });
  emit('task.failed', { subjectType: 'task', subjectId: task.id, payload: { responsibilityId: task.responsibility_id, error: message } });
  return 'failed';
}

/** Called by the supervisor (or at boot) for runs whose lease expired. */
export function abandonRun(run: Row, reason: string) {
  q.run("UPDATE task_runs SET state = 'abandoned', ended_at = ?, error = ? WHERE id = ?", now(), reason, run.id);
  const task = q.get('SELECT * FROM tasks WHERE id = ?', run.task_id);
  if (!task || task.state !== 'RUNNING') return;
  const step = q.get('SELECT * FROM task_steps WHERE task_id = ? AND idx = ?', task.id, task.current_step);
  if (step?.state === 'running') update('task_steps', step.id, { state: 'pending' });
  const recoveries = task.recoveries + 1;
  if (recoveries >= POISON_THRESHOLD) {
    // The same task keeps taking the worker down with it: quarantine it so everything else keeps running.
    const diagnosis = diagnose(new Error(`keeps crashing the worker (${recoveries} times, last during “${step?.title ?? 'a step'}”)`), 'permanent', 'Quarantined');
    setState(task.id, 'FAILED', { recoveries, diagnosis, error: 'Quarantined after repeated crashes', completed_at: now(), attention: 'problem', now_line: 'Quarantined after repeated crashes' });
    activity('problem', `Quarantined “${task.title}”`, { taskId: task.id, responsibilityId: task.responsibility_id, detail: diagnosis });
    notify('attention', `AUDA quarantined “${task.title}”`, diagnosis, { type: 'task', id: task.id });
    emit('task.failed', { subjectType: 'task', subjectId: task.id, payload: { responsibilityId: task.responsibility_id, error: 'quarantined' } });
    return;
  }
  setState(task.id, 'RECOVERING', { recoveries, now_line: 'Recovering from the last checkpoint' });
  activity('recover', `Recovering “${task.title}”`, {
    taskId: task.id, responsibilityId: task.responsibility_id, spaceId: task.space_id,
    detail: `${reason}. Resuming from step ${task.current_step + 1}${step ? ` (“${step.title}”)` : ''}; completed steps are not repeated.`,
  });
  emit('task.recovering', { subjectType: 'task', subjectId: task.id, payload: { reason } });
  setTimeout(() => {
    const t = q.get('SELECT state FROM tasks WHERE id = ?', task.id);
    if (t?.state === 'RECOVERING') { setState(task.id, 'READY'); kick(); }
  }, 1500);
}

// ─── step context ────────────────────────────────────────────────────────────

let narrationHook: (taskId: string, text: string) => void = () => {};
export const onNarration = (fn: typeof narrationHook) => { narrationHook = fn; };

function makeCtx(task: Row, stepIdx: number, vars: Record<string, any>, signal: AbortSignal): StepCtx {
  const meta = { taskId: task.id, responsibilityId: task.responsibility_id, spaceId: task.space_id };
  return {
    task, input: json(task.input_json, {}), vars, stepIdx, signal,
    narrate(text) {
      update('tasks', task.id, { now_line: text, updated_at: now() });
      changed('task', task.id);
      narrationHook(task.id, text);
    },
    log(kind, title, detail, raw) { activity(kind, title, { ...meta, detail, raw }); },
    tool(cap, input, opts = {}) {
      return call(cap, input, { taskId: task.id, stepIdx, spaceId: task.space_id, why: opts.why, approval: opts.approval });
    },
    async decide(spec, actions) {
      const items = actions.map((a) => ({ ...a, capability: a.capability, inputHash: hash(a.input) }));
      const needs = items.filter((a) => decide(a.capability, a.input, { spaceId: task.space_id }).verdict !== 'allow');
      const denied = items.find((a) => decide(a.capability, a.input, { spaceId: task.space_id }).verdict === 'deny');
      if (denied) throw new PolicyDenied(denied.capability, decide(denied.capability, denied.input, { spaceId: task.space_id }).reason);
      if (!needs.length) return 'not-needed';
      const inputHash = hash(items.map((i) => [i.capability, i.inputHash]));
      const existing = q.get("SELECT * FROM approvals WHERE task_id = ? AND step_idx = ? AND capability = 'plan' AND input_hash = ? ORDER BY created_at DESC LIMIT 1", task.id, stepIdx, inputHash);
      if (existing?.state === 'approved') return 'approved';
      if (existing?.state === 'rejected') return 'rejected';
      if (existing?.state === 'pending') throw new NeedsApproval(existing.id, existing.title);
      const id = uid('apr');
      insert('approvals', {
        id, task_id: task.id, step_idx: stepIdx, capability: 'plan', input_hash: inputHash, title: spec.title, summary: spec.summary,
        recommendation: spec.recommendation, impact: spec.impact, if_yes: spec.ifYes, if_no: spec.ifNo,
        approve_label: spec.approveLabel, reject_label: spec.rejectLabel, evidence_json: JSON.stringify(spec.evidence ?? []),
        actions_json: JSON.stringify(items.map((i) => ({ capability: i.capability, inputHash: i.inputHash, describe: capabilities[i.capability].describe(i.input), level: decide(i.capability, i.input, { spaceId: task.space_id }).verdict }))),
        state: 'pending', created_at: now(),
      });
      changed('approval', id);
      activity('approval', spec.title, { ...meta, detail: spec.summary });
      emit('approval.requested', { subjectType: 'approval', subjectId: id, payload: { taskId: task.id } });
      notify('approval', spec.title, spec.summary, { type: 'approval', id });
      throw new NeedsApproval(id, spec.title);
    },
    async artifact(name, content, o) {
      return saveArtifact({ name, content, mime: o.mime, why: o.why, taskId: task.id, responsibilityId: task.responsibility_id, spaceId: task.space_id });
    },
    remember(m) {
      remember({
        kind: m.kind, title: m.title, content: m.content, weight: m.weight, confidence: m.confidence, data: m.data,
        source: 'task', sourceRef: task.id, responsibilityId: task.responsibility_id, spaceId: task.space_id,
        expiresAt: m.expiresInMs ? now() + m.expiresInMs : undefined,
      });
      activity('memory', `Remembered: ${m.title}`, { ...meta, detail: m.content });
    },
    notify(level, title, body) { notify(level as NotifyLevel, title, body, { type: 'task', id: task.id }); },
    memories(query, limit) { return recall(query, { responsibilityId: task.responsibility_id, spaceId: task.space_id, limit }); },
  };
}

export const runningTaskIds = () => [...running.keys()];
