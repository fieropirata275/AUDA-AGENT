/**
 * Presence: AUDA's current state, derived from what it is actually doing.
 * Never a spinner — always a state plus one honest sentence.
 */
import { getSetting, now, q, update } from '../core/db.ts';
import { changed, onChanges } from '../core/changes.ts';
import { emit } from '../core/bus.ts';
import { onThinking } from '../models/router.ts';
import * as browser from '../computer/browser.ts';

export type Presence = 'available' | 'thinking' | 'working' | 'browsing' | 'coding' | 'waiting' | 'watching' | 'scheduled' | 'needs_you' | 'blocked' | 'idle' | 'recovering' | 'listening';

let thinking = 0;
let listeningUntil = 0;
let recoveringUntil = 0;

export function setListening(ms = 2500) { listeningUntil = now() + ms; schedule(); }
export function setRecovering(ms = 6000) { recoveringUntil = now() + ms; schedule(); }

export function computePresence(): { presence: Presence; narration: string; subject?: string } {
  const t = now();
  if (recoveringUntil > t) return { presence: 'recovering', narration: 'Something stopped responding. I’m restoring it from the last checkpoint.' };
  const pending = q.get("SELECT a.title, a.task_id FROM approvals a WHERE a.state = 'pending' ORDER BY a.created_at LIMIT 1");
  const running = q.get("SELECT t.*, s.title AS step_title FROM tasks t LEFT JOIN task_steps s ON s.task_id = t.id AND s.idx = t.current_step WHERE t.state IN ('RUNNING','RECOVERING') ORDER BY t.updated_at DESC LIMIT 1");
  if (listeningUntil > t && !running) return { presence: 'listening', narration: 'Listening.' };
  if (running) {
    const tool = browser.activity && t - browser.activity.ts < 8000 ? 'browsing' : /terminal|command|measur|sampl|list|re-measur/i.test(running.now_line ?? '') ? 'coding' : 'working';
    if (running.state === 'RECOVERING') return { presence: 'recovering', narration: running.now_line ?? 'Recovering.', subject: running.id };
    return { presence: thinking > 0 ? 'thinking' : tool as Presence, narration: running.now_line ?? running.title, subject: running.id };
  }
  if (thinking > 0) return { presence: 'thinking', narration: 'Thinking it through.' };
  if (pending) return { presence: 'needs_you', narration: pending.title, subject: pending.task_id };
  const blocked = q.get("SELECT id, title, error FROM tasks WHERE state = 'WAITING_USER' AND attention = 'problem' LIMIT 1");
  if (blocked) return { presence: 'blocked', narration: `I’m blocked on “${blocked.title}”.`, subject: blocked.id };
  const waiting = q.get("SELECT id, title, now_line FROM tasks WHERE state IN ('WAITING_EXTERNAL','RETRYING') ORDER BY updated_at DESC LIMIT 1");
  if (waiting) return { presence: 'waiting', narration: waiting.now_line ?? `Waiting on “${waiting.title}”.`, subject: waiting.id };
  const watching = q.get("SELECT COUNT(*) n FROM responsibilities WHERE state IN ('WATCHING','HANDLING')")!.n;
  if (watching) return { presence: 'watching', narration: `Watching ${watching} thing${watching > 1 ? 's' : ''}. Nothing needs you.` };
  const scheduled = q.get("SELECT COUNT(*) n FROM tasks WHERE state = 'SCHEDULED'")!.n;
  if (scheduled) return { presence: 'scheduled', narration: `${scheduled} thing${scheduled > 1 ? 's' : ''} scheduled for later.` };
  const last = q.get('SELECT MAX(ts) ts FROM activity')?.ts ?? 0;
  if (t - last > 30 * 60_000) return { presence: 'idle', narration: 'Resting. Give me something to look after.' };
  return { presence: 'available', narration: 'Ready when you are.' };
}

let timer: NodeJS.Timeout | null = null;
function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const p = computePresence();
    const cur = q.get('SELECT presence, narration FROM identity LIMIT 1');
    if (cur && (cur.presence !== p.presence || cur.narration !== p.narration)) {
      const id = q.get('SELECT id FROM identity LIMIT 1')!.id;
      update('identity', id, { presence: p.presence, narration: p.narration, presence_subject: p.subject ?? null, updated_at: now() });
      changed('identity', id);
      if (cur.presence !== p.presence) emit('presence.changed', { payload: { from: cur.presence, to: p.presence } });
    }
  }, 120);
}

export function initPresence() {
  onChanges((batch) => { if (batch.some((b) => ['task', 'approval', 'responsibility'].includes(b.entity))) schedule(); });
  onThinking((n) => { thinking = n; schedule(); });
  setInterval(schedule, 3000);
  schedule();
}

/** A short spoken summary, used for greetings and status questions. */
export function presenceSummary(): string {
  const since = getSetting<number>('user.lastSeen', now() - 12 * 3600_000);
  const done = q.all("SELECT title, result_summary FROM tasks WHERE state = 'COMPLETED' AND completed_at >= ? ORDER BY completed_at DESC LIMIT 5", since);
  const running = q.all("SELECT title, now_line FROM tasks WHERE state IN ('RUNNING','READY','RETRYING','RECOVERING')");
  const watching = q.get("SELECT COUNT(*) n FROM responsibilities WHERE state IN ('WATCHING','HANDLING','NEEDS_USER')")!.n;
  const needs = q.all("SELECT title FROM approvals WHERE state = 'pending'");
  const parts: string[] = [];
  if (done.length) parts.push(`I finished ${done.length} thing${done.length > 1 ? 's' : ''} since you were last here:\n${done.map((d) => `• ${d.result_summary ?? d.title}`).join('\n')}`);
  if (running.length) parts.push(`Right now: ${running[0].now_line ?? running[0].title}`);
  parts.push(watching ? `I’m watching ${watching} thing${watching > 1 ? 's' : ''}.` : 'I’m not responsible for anything yet — tell me what to look after.');
  if (needs.length) parts.push(`${needs.length === 1 ? 'One thing needs' : `${needs.length} things need`} you: ${needs.map((n) => n.title).join(' · ')}`);
  else parts.push('Nothing needs you.');
  return parts.join('\n\n');
}
