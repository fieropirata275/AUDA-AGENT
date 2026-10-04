/**
 * Notifications. The goal is minimum unnecessary interruption: every
 * notification has an importance level, quiet rules can silence levels, and
 * silenced items still land in the inbox so nothing is hidden.
 */
import { getSetting, insert, now, uid } from '../core/db.ts';
import { changed } from '../core/changes.ts';
import { emit } from '../core/bus.ts';
import { quietLevels } from '../policy/engine.ts';
import { log } from '../core/log.ts';

export type NotifyLevel = 'fyi' | 'completed' | 'attention' | 'approval' | 'blocked' | 'urgent' | 'watching';

export const DEFAULT_PREFS: Record<NotifyLevel, 'interrupt' | 'inbox' | 'silent'> = {
  urgent: 'interrupt', approval: 'interrupt', blocked: 'interrupt', attention: 'interrupt',
  completed: 'inbox', fyi: 'inbox', watching: 'silent',
};

export function notify(level: NotifyLevel, title: string, body?: string, subject?: { type: string; id: string }) {
  const prefs = { ...DEFAULT_PREFS, ...getSetting<Partial<typeof DEFAULT_PREFS>>('notifications.prefs', {}) };
  const quiet = quietLevels();
  const pref = quiet.has(level) && level !== 'urgent' ? 'silent' : prefs[level];
  const id = uid('ntf');
  insert('notifications', {
    id, level, title, body, subject_type: subject?.type, subject_id: subject?.id,
    delivered: pref === 'interrupt' ? 1 : 0,
    suppressed_reason: pref === 'silent' ? (quiet.has(level) ? 'quiet rule' : 'preference') : undefined,
    read_at: pref === 'silent' ? now() : undefined, created_at: now(),
  });
  changed('notification', id);
  emit('notification.created', { subjectType: 'notification', subjectId: id, payload: { level, delivered: pref === 'interrupt' } });
  if (pref === 'interrupt') void outbound(level, title, body);
  return id;
}

/** Optional outbound channel (Slack/Discord-compatible webhook, ntfy, …). */
async function outbound(level: string, title: string, body?: string) {
  const url = getSetting<string>('notifications.webhook', '');
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `AUDA · ${title}${body ? `\n${body}` : ''}`, content: `AUDA · ${title}`, level, title, body }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) { log.warn('notification webhook failed', String(e)); }
}
