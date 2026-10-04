import { insert, now, uid } from './db.ts';
import { changed } from './changes.ts';

export type ActivityKind =
  | 'observe' | 'reason' | 'act' | 'wait' | 'approval' | 'recover' | 'complete'
  | 'problem' | 'memory' | 'system' | 'user' | 'schedule';

/** Human-oriented timeline entry. Raw detail goes into raw (debug view). */
export function activity(kind: ActivityKind, title: string, o: {
  detail?: string; taskId?: string; responsibilityId?: string; spaceId?: string | null; raw?: unknown;
} = {}) {
  const id = uid('act');
  insert('activity', {
    id, ts: now(), kind, title, detail: o.detail, task_id: o.taskId, responsibility_id: o.responsibilityId,
    space_id: o.spaceId ?? undefined, raw_json: o.raw === undefined ? undefined : JSON.stringify(o.raw),
  });
  changed('activity', id);
  return id;
}
