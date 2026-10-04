/**
 * Responsibilities: goals that stay alive. They own their wake-up sources
 * (watchers, schedules, triggers), spawn tasks through their playbook, and
 * return to WATCHING when a task ends. They end only when you end them.
 */
import { insert, json, now, q, uid, update, type Row } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { emit, on, matches, type AudaEvent } from '../core/bus.ts';
import { activity } from '../core/activity.ts';
import { playbook } from '../playbooks/types.ts';
import { createTask, cancelTask, TERMINAL } from '../tasks/engine.ts';
import { setWatchersEnabled } from '../watchers/runner.ts';
import { setOwnerSchedulesEnabled } from '../scheduler/scheduler.ts';
import { remember } from '../memory/service.ts';

export interface CreateResponsibility {
  playbook: string;
  title: string;
  description?: string;
  config?: Record<string, any>;
  spaceId?: string | null;
  origin?: Record<string, any>;
}

export function createResponsibility(r: CreateResponsibility): string {
  const pb = playbook(r.playbook);
  if (!pb.responsibility) throw new Error(`${pb.title} can’t be an ongoing responsibility`);
  const id = uid('resp');
  const ts = now();
  insert('responsibilities', {
    id, title: r.title, description: r.description, playbook: r.playbook, state: 'WATCHING', space_id: r.spaceId ?? undefined,
    config_json: JSON.stringify(r.config ?? {}), origin_json: JSON.stringify(r.origin ?? {}),
    status_line: pb.responsibility.describe(r.config ?? {}), created_at: ts, updated_at: ts,
  });
  const row = q.get('SELECT * FROM responsibilities WHERE id = ?', id)!;
  pb.responsibility.setup(row);
  changed('responsibility', id);
  activity('reason', `Took on a responsibility: ${r.title}`, { responsibilityId: id, spaceId: r.spaceId, detail: pb.responsibility.describe(r.config ?? {}) });
  remember({ kind: 'operational', title: `Responsibility: ${r.title}`, content: `${r.description ?? r.title}. ${pb.responsibility.describe(r.config ?? {})}`, source: 'system', responsibilityId: id, spaceId: r.spaceId, weight: 'defining', confidence: 0.95, expiresAt: null });
  emit('responsibility.created', { subjectType: 'responsibility', subjectId: id });
  loadTriggers();
  return id;
}

function setState(id: string, state: string, patch: Row = {}) {
  update('responsibilities', id, { state, updated_at: now(), ...patch });
  changed('responsibility', id);
}

export function openTask(respId: string) {
  return q.get(`SELECT * FROM tasks WHERE responsibility_id = ? AND state NOT IN (${TERMINAL.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`, respId, ...TERMINAL);
}

/** Something happened that this responsibility cares about. */
export function wake(respId: string, event: AudaEvent) {
  const resp = q.get('SELECT * FROM responsibilities WHERE id = ?', respId);
  if (!resp || ['PAUSED', 'ENDED', 'DRAFT'].includes(resp.state)) return;
  const pb = playbook(resp.playbook);
  // Replayed events (after a crash) must not spawn a second task for the same signal.
  if (q.get("SELECT 1 FROM tasks WHERE responsibility_id = ? AND json_extract(origin_json, '$.eventId') = ?", respId, event.id)) return;
  const open = openTask(respId);
  if (open) {
    // Already on it: don't spawn duplicates, but don't drop the signal either.
    if (event.type === 'watcher.fired') activity('observe', `Still handling “${open.title}”`, { responsibilityId: respId, taskId: open.id, detail: `New signal: ${event.payload.value ?? event.type}` });
    return;
  }
  const spawn = pb.responsibility!.onWake(resp, event);
  update('responsibilities', respId, { last_triggered_at: now(), trigger_count: resp.trigger_count + 1 });
  emit('responsibility.triggered', { subjectType: 'responsibility', subjectId: respId, payload: { event: event.type } });
  if (!spawn) { changed('responsibility', respId); return; }
  activity('observe', describeWake(event, resp), { responsibilityId: respId, spaceId: resp.space_id, detail: event.payload.value });
  const taskId = createTask({
    title: spawn.title, goal: spawn.goal, playbook: resp.playbook, input: { ...json(resp.config_json, {}), ...spawn.input },
    responsibilityId: respId, spaceId: resp.space_id, origin: { type: 'event', event: event.type, eventId: event.id }, priority: spawn.priority,
  });
  setState(respId, 'HANDLING', { status_line: spawn.title });
  return taskId;
}

function describeWake(e: AudaEvent, resp: Row) {
  switch (e.type) {
    case 'watcher.fired': return `Noticed: ${e.payload.headline ?? e.payload.value ?? 'a change'}`;
    case 'schedule.fired': return e.payload.late ? `Running “${resp.title}” (it was due while AUDA was offline)` : `Time for “${resp.title}”`;
    case 'connector.webhook.received': return `Webhook received: ${e.payload.slug}`;
    case 'connector.github.workflow_failed': return `CI failed on ${e.payload.repo}`;
    default: return `Woke up for “${resp.title}”`;
  }
}

export function pauseResponsibility(id: string) {
  setState(id, 'PAUSED');
  setWatchersEnabled(id, false); setOwnerSchedulesEnabled(id, false);
  q.run('UPDATE triggers SET enabled = 0 WHERE responsibility_id = ?', id); loadTriggers();
  activity('user', `Paused responsibility: ${q.get('SELECT title FROM responsibilities WHERE id = ?', id)?.title}`, { responsibilityId: id });
}
export function resumeResponsibility(id: string) {
  setState(id, openTask(id) ? 'HANDLING' : 'WATCHING');
  setWatchersEnabled(id, true); setOwnerSchedulesEnabled(id, true);
  q.run('UPDATE triggers SET enabled = 1 WHERE responsibility_id = ?', id); loadTriggers();
  activity('user', `Resumed responsibility: ${q.get('SELECT title FROM responsibilities WHERE id = ?', id)?.title}`, { responsibilityId: id });
}
export function endResponsibility(id: string) {
  const open = openTask(id);
  if (open) cancelTask(open.id, 'Responsibility ended');
  setState(id, 'ENDED', { status_line: 'No longer watching' });
  setWatchersEnabled(id, false); setOwnerSchedulesEnabled(id, false);
  q.run('UPDATE triggers SET enabled = 0 WHERE responsibility_id = ?', id); loadTriggers();
  activity('user', `Stopped watching: ${q.get('SELECT title FROM responsibilities WHERE id = ?', id)?.title}`, { responsibilityId: id });
}
export async function wakeNow(id: string) {
  const resp = q.get('SELECT * FROM responsibilities WHERE id = ?', id);
  if (!resp) return;
  const e: AudaEvent = { id: uid('evt'), type: 'responsibility.manual', source: 'user', payload: { value: 'You asked AUDA to check now' }, createdAt: now() };
  return wake(id, e);
}

// ─── event wiring ────────────────────────────────────────────────────────────

let triggers: Row[] = [];
export function loadTriggers() { triggers = q.all('SELECT * FROM triggers WHERE enabled = 1'); }

export function addTrigger(responsibilityId: string, pattern: string, filter: Record<string, any>, description: string) {
  insert('triggers', { id: uid('trg'), responsibility_id: responsibilityId, event_pattern: pattern, filter_json: JSON.stringify(filter), description, created_at: now() });
  loadTriggers();
}

export function initResponsibilities() {
  loadTriggers();
  on('watcher.fired', (e) => { if (e.subjectId) wake(e.subjectId, e); });
  on('schedule.fired', (e) => { if (e.subjectType === 'responsibility' && e.subjectId) wake(e.subjectId, e); });
  on('*', (e) => {
    for (const t of triggers) {
      if (!matches(t.event_pattern, e.type)) continue;
      const f = json<Record<string, any>>(t.filter_json, {});
      if (Object.entries(f).every(([k, v]) => e.payload[k] === v)) {
        q.run('UPDATE triggers SET last_fired_at = ? WHERE id = ?', now(), t.id);
        wake(t.responsibility_id, e);
      }
    }
  });
  const settle = (e: AudaEvent) => {
    const rid = e.payload.responsibilityId;
    if (!rid) return;
    const resp = q.get('SELECT * FROM responsibilities WHERE id = ?', rid);
    if (!resp || ['PAUSED', 'ENDED'].includes(resp.state)) return;
    if (openTask(rid)) return;
    const pb = playbook(resp.playbook);
    const outcome = e.type === 'task.completed' ? e.payload.summary : e.type === 'task.failed' ? `Last attempt failed: ${e.payload.error}` : 'Last task was stopped';
    setState(rid, 'WATCHING', { last_outcome: outcome, status_line: pb.responsibility!.describe(json(resp.config_json, {})) });
    activity('wait', `Back to watching: ${resp.title}`, { responsibilityId: rid, spaceId: resp.space_id });
  };
  on('task.completed', settle);
  on('task.failed', settle);
  on('task.cancelled', settle);
  on('task.waiting', (e) => {
    const t = q.get('SELECT responsibility_id FROM tasks WHERE id = ?', e.subjectId);
    if (t?.responsibility_id && e.payload.on === 'user') setState(t.responsibility_id, 'NEEDS_USER');
  });
  on('approval.*', (e) => {
    const t = q.get('SELECT responsibility_id FROM tasks WHERE id = ?', e.payload.taskId);
    if (t?.responsibility_id && e.type !== 'approval.requested') setState(t.responsibility_id, 'HANDLING');
  });
  on('task.resumed', (e) => {
    const t = q.get('SELECT responsibility_id FROM tasks WHERE id = ?', e.subjectId);
    if (t?.responsibility_id) setState(t.responsibility_id, 'HANDLING');
  });
}
