/**
 * Event bus with an outbox. Every event is persisted *before* dispatch and
 * marked dispatched only after all its handlers settle, so a crash between
 * "something happened" and "AUDA reacted" is replayed on the next boot
 * instead of silently lost.
 */
import { insert, now, q, uid } from './db.ts';
import { log } from './log.ts';

export interface AudaEvent {
  id: string;
  type: string;
  source: string;
  subjectType?: string;
  subjectId?: string;
  payload: Record<string, any>;
  createdAt: number;
  replayed?: boolean;
}
type Handler = (e: AudaEvent) => void | Promise<void>;

const handlers: { pattern: string; fn: Handler }[] = [];
export const busStats = { dispatched: 0, failedHandlers: 0, replayed: 0 };

/** Subscribe to events. Patterns: exact type, 'prefix.*', or '*'. */
export function on(pattern: string, fn: Handler) {
  handlers.push({ pattern, fn });
  return () => { const i = handlers.findIndex((h) => h.fn === fn); if (i >= 0) handlers.splice(i, 1); };
}

export function matches(pattern: string, type: string) {
  if (pattern === '*' || pattern === type) return true;
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  return false;
}

function dispatch(e: AudaEvent) {
  setImmediate(async () => {
    const results = await Promise.allSettled(handlers.filter((h) => matches(h.pattern, e.type)).map((h) => Promise.resolve().then(() => h.fn(e))));
    for (const r of results) if (r.status === 'rejected') { busStats.failedHandlers++; log.error(`event handler for ${e.type} failed`, r.reason); }
    busStats.dispatched++;
    try { q.run('UPDATE events SET dispatched = 1 WHERE id = ?', e.id); } catch { /* db closing */ }
  });
}

/** Persist an event and dispatch it asynchronously to subscribers. */
export function emit(type: string, opts: { source?: string; subjectType?: string; subjectId?: string; payload?: Record<string, any> } = {}): AudaEvent {
  const e: AudaEvent = {
    id: uid('evt'), type, source: opts.source ?? 'core', subjectType: opts.subjectType, subjectId: opts.subjectId,
    payload: opts.payload ?? {}, createdAt: now(),
  };
  insert('events', {
    id: e.id, type, source: e.source, subject_type: e.subjectType, subject_id: e.subjectId,
    payload_json: JSON.stringify(e.payload), created_at: e.createdAt, dispatched: 0,
  });
  dispatch(e);
  return e;
}

/** Re-deliver events a previous process persisted but never finished handling. */
export function replayPending(maxAgeMs = 6 * 3600_000) {
  const rows = q.all('SELECT * FROM events WHERE dispatched = 0 AND created_at > ? ORDER BY created_at', now() - maxAgeMs);
  for (const r of rows) {
    busStats.replayed++;
    dispatch({ id: r.id, type: r.type, source: r.source, subjectType: r.subject_type, subjectId: r.subject_id, payload: JSON.parse(r.payload_json), createdAt: r.created_at, replayed: true });
  }
  q.run('UPDATE events SET dispatched = 1 WHERE dispatched = 0 AND created_at <= ?', now() - maxAgeMs);
  return rows.length;
}

/** Keep the events table bounded. */
export function pruneEvents(keepDays = 14) { q.run('DELETE FROM events WHERE dispatched = 1 AND created_at < ?', now() - keepDays * 86400_000); }
