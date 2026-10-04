import { insert, now, uid } from './db.ts';
import { log } from './log.ts';

export interface AudaEvent {
  id: string;
  type: string;
  source: string;
  subjectType?: string;
  subjectId?: string;
  payload: Record<string, any>;
  createdAt: number;
}
type Handler = (e: AudaEvent) => void | Promise<void>;

const handlers: { pattern: string; fn: Handler }[] = [];

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

/** Persist an event and dispatch it asynchronously to subscribers. */
export function emit(type: string, opts: { source?: string; subjectType?: string; subjectId?: string; payload?: Record<string, any> } = {}): AudaEvent {
  const e: AudaEvent = {
    id: uid('evt'), type, source: opts.source ?? 'core', subjectType: opts.subjectType, subjectId: opts.subjectId,
    payload: opts.payload ?? {}, createdAt: now(),
  };
  insert('events', {
    id: e.id, type, source: e.source, subject_type: e.subjectType, subject_id: e.subjectId,
    payload_json: JSON.stringify(e.payload), created_at: e.createdAt,
  });
  setImmediate(() => {
    for (const h of handlers.slice()) {
      if (!matches(h.pattern, type)) continue;
      Promise.resolve()
        .then(() => h.fn(e))
        .catch((err) => log.error(`event handler for ${type} failed`, err));
    }
  });
  return e;
}
