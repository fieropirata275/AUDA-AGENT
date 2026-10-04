/** Scheduler: time-based wake-ups. Durable — schedules live in the database. */
import { insert, now, q, uid, update } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { emit } from '../core/bus.ts';
import { nextCron } from './cron.ts';
import type { ParsedSchedule } from './fuzzy.ts';
import { log } from '../core/log.ts';

export function addSchedule(ownerType: string, ownerId: string, p: ParsedSchedule) {
  const id = uid('sch');
  insert('schedules', {
    id, owner_type: ownerType, owner_id: ownerId, kind: p.kind, spec: p.spec, description: p.description,
    next_run_at: p.nextRunAt, window_end: p.windowEnd, enabled: 1, created_at: now(),
  });
  changed('schedule', id);
  return id;
}

export function setOwnerSchedulesEnabled(ownerId: string, enabled: boolean) {
  for (const s of q.all('SELECT id, kind, spec FROM schedules WHERE owner_id = ?', ownerId)) {
    const patch: Record<string, any> = { enabled: enabled ? 1 : 0 };
    if (enabled && s.kind === 'cron') patch.next_run_at = nextCron(s.spec);
    if (enabled && s.kind === 'interval') patch.next_run_at = now() + Number(s.spec) * 1000;
    update('schedules', s.id, patch);
    changed('schedule', s.id);
  }
}

function advance(s: any) {
  const t = now();
  if (s.kind === 'cron') return { next_run_at: nextCron(s.spec, t) };
  if (s.kind === 'interval') return { next_run_at: t + Number(s.spec) * 1000 };
  return { enabled: 0, next_run_at: null };
}

let timer: NodeJS.Timeout | null = null;
export function startScheduler() {
  timer = setInterval(() => {
    const t = now();
    for (const s of q.all('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?', t)) {
      try {
        // A missed window (AUDA was off) still fires once, and says so.
        const late = t - s.next_run_at > 120_000;
        update('schedules', s.id, { last_run_at: t, ...advance(s) });
        changed('schedule', s.id);
        emit('schedule.fired', { subjectType: s.owner_type, subjectId: s.owner_id, payload: { scheduleId: s.id, description: s.description, late, missedBy: late ? t - s.next_run_at : 0 } });
      } catch (e) { log.error('schedule failed', e); }
    }
  }, 1000);
}
export const stopScheduler = () => timer && clearInterval(timer);
